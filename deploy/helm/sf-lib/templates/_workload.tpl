{{/*
sf-lib.workload renders everything one component needs from a values block:
ServiceAccount, Deployment|StatefulSet, Service, PodDisruptionBudget, NetworkPolicy.

Usage: {{ include "sf-lib.workload" (dict "ctx" $ "name" "catalog-api" "c" .Values.catalogApi) }}

Component keys (all optional unless noted):
  image: {repository (required), tag}      kind: Deployment|StatefulSet
  replicas, command, args, port, env (map, values go through tpl), envFrom (list of raw envFrom),
  secretEnv: [{name, secret, key}], resources, pdb: {minAvailable|maxUnavailable},
  probes: {liveness: path, readiness: path, port, initialDelaySeconds},
  readOnlyRootFilesystem (default true), runAsUser (default 65532), fsGroup,
  emptyDirs: [{name, mountPath, sizeLimit, medium}], files: [{name, mountPath, configMap|secret, subPath}],
  persistence: {size, mountPath, storageClass} (StatefulSet only),
  terminationGracePeriodSeconds, podLabels,
  networkPolicy: {from: [component | "ingress"], ports: [int], to: [{name|cnpgCluster, port}], kubeApi: bool, allowSelf: bool}
  probes.tcp: true uses tcpSocket checks (for servers without an HTTP health endpoint)
  metricsPort: port serving /metrics (Prometheus PodMonitor + NetworkPolicy from the monitoring namespace)
  keda: {queue, maxReplicas, minReplicas, targetPerReplica, cooldownPeriod} -> ScaledObject on the SQS queue (replicas omitted)
  hpa: {minReplicas, maxReplicas, cpu} -> CPU HorizontalPodAutoscaler (replicas omitted)
  preStopSeconds: sleep before SIGTERM so endpoints drop the pod first (default 5 when port is set)
  networkPolicy.fromNamespaces: [ns] -> extra ingress from whole namespaces (e.g. keda)
global.observability: {enabled, namespace, otlpEndpoint} -> OTLP env + scrape/export NetworkPolicy rules
*/}}

{{- define "sf-lib.labels" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/part-of: streamforge
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/managed-by: {{ .ctx.Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .ctx.Chart.Name .ctx.Chart.Version }}
{{- end }}

{{/* Our images get global.registry + global.imageTag; upstream images set image.external: true and a tag. */}}
{{- define "sf-lib.image" -}}
{{- $g := .ctx.Values.global | default dict -}}
{{- $repo := .c.image.repository -}}
{{- if not .c.image.external }}{{ $repo = printf "%s/%s" $g.registry $repo }}{{ end -}}
{{- $tag := .c.image.tag | default $g.imageTag | required (printf "image tag for %s" .c.image.repository) -}}
{{- printf "%s:%s" $repo (toString $tag) -}}
{{- end }}

{{- define "sf-lib.workload" -}}
{{- $ctx := .ctx -}}{{- $name := .name -}}{{- $c := .c -}}
{{- $kind := $c.kind | default "Deployment" -}}
{{- $labels := include "sf-lib.labels" . -}}
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ $name }}
  labels: {{- $labels | nindent 4 }}
automountServiceAccountToken: {{ $c.networkPolicy.kubeApi | default false }}
---
apiVersion: apps/v1
kind: {{ $kind }}
metadata:
  name: {{ $name }}
  labels: {{- $labels | nindent 4 }}
spec:
  {{- if not (or $c.keda $c.hpa) }}
  replicas: {{ $c.replicas | default 1 }}
  {{- end }}
  {{- if eq $kind "StatefulSet" }}
  serviceName: {{ $name }}
  {{- end }}
  selector:
    matchLabels:
      app.kubernetes.io/name: {{ $name }}
      app.kubernetes.io/instance: {{ $ctx.Release.Name }}
  template:
    metadata:
      labels:
        {{- $labels | nindent 8 }}
        {{- with $c.podLabels }}{{ toYaml . | nindent 8 }}{{ end }}
        {{- if $c.metricsPort }}
        streamforge.io/metrics: "true"
        {{- end }}
      annotations:
        checksum/values: {{ toJson $c | sha256sum | trunc 16 }}
    spec:
      serviceAccountName: {{ $name }}
      automountServiceAccountToken: {{ $c.networkPolicy.kubeApi | default false }}
      terminationGracePeriodSeconds: {{ $c.terminationGracePeriodSeconds | default 30 }}
      securityContext:
        runAsNonRoot: true
        runAsUser: {{ $c.runAsUser | default 65532 }}
        runAsGroup: {{ $c.runAsUser | default 65532 }}
        fsGroup: {{ $c.fsGroup | default ($c.runAsUser | default 65532) }}
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: {{ $name }}
          image: {{ include "sf-lib.image" (dict "ctx" $ctx "c" $c) }}
          imagePullPolicy: IfNotPresent
          {{- with $c.command }}
          command: {{ toYaml . | nindent 12 }}
          {{- end }}
          {{- with $c.args }}
          args: {{ toYaml . | nindent 12 }}
          {{- end }}
          {{- if or $c.port $c.metricsPort }}
          ports:
            {{- if $c.port }}
            - name: http
              containerPort: {{ $c.port }}
            {{- end }}
            {{- if and $c.metricsPort (ne (toString $c.metricsPort) (toString $c.port)) }}
            - name: metrics
              containerPort: {{ $c.metricsPort }}
            {{- end }}
          {{- end }}
          {{- $obs := ($ctx.Values.global | default dict).observability | default dict }}
          {{- if or $c.env $c.secretEnv $obs.enabled }}
          env:
            {{- if $obs.enabled }}
            - { name: OTEL_EXPORTER_OTLP_ENDPOINT, value: {{ $obs.otlpEndpoint | quote }} }
            - { name: OTEL_SERVICE_NAME, value: {{ $name | quote }} }
            - { name: OTEL_RESOURCE_ATTRIBUTES, value: "deployment.environment={{ $ctx.Release.Namespace }}" }
            {{- end }}
            {{- range $k, $v := $c.env }}
            - name: {{ $k }}
              value: {{ tpl (toString $v) $ctx | quote }}
            {{- end }}
            {{- range $c.secretEnv }}
            - name: {{ .name }}
              valueFrom:
                secretKeyRef: { name: {{ tpl .secret $ctx }}, key: {{ .key }} }
            {{- end }}
          {{- end }}
          {{- with $c.probes }}
          {{- $check := ternary (printf "tcpSocket: { port: %v }" (.port | default $c.port)) (printf "httpGet: { path: %s, port: %v }" (.liveness | default "/healthz") (.port | default $c.port)) (.tcp | default false) }}
          {{- $ready := ternary (printf "tcpSocket: { port: %v }" (.port | default $c.port)) (printf "httpGet: { path: %s, port: %v }" (.readiness | default "/readyz") (.port | default $c.port)) (.tcp | default false) }}
          livenessProbe:
            {{ $check }}
            initialDelaySeconds: {{ .initialDelaySeconds | default 5 }}
            periodSeconds: 10
            timeoutSeconds: 3
            failureThreshold: 6
          readinessProbe:
            {{ $ready }}
            periodSeconds: 5
            timeoutSeconds: 3
            failureThreshold: 3
          {{- end }}
          {{- $preStop := $c.preStopSeconds | default (ternary 5 0 (not (empty $c.port))) }}
          {{- if gt (int $preStop) 0 }}
          lifecycle:
            # Let the Service/ingress drop this endpoint before SIGTERM (no 5xx during rollouts).
            preStop: { sleep: { seconds: {{ $preStop }} } }
          {{- end }}
          resources: {{- toYaml ($c.resources | default dict) | nindent 12 }}
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: {{ if hasKey $c "readOnlyRootFilesystem" }}{{ $c.readOnlyRootFilesystem }}{{ else }}true{{ end }}
            capabilities: { drop: [ALL] }
          volumeMounts:
            {{- range $c.emptyDirs }}
            - { name: {{ .name }}, mountPath: {{ .mountPath }} }
            {{- end }}
            {{- range $c.files }}
            - name: {{ .name }}
              mountPath: {{ .mountPath }}
              {{- with .subPath }}
              subPath: {{ . }}
              {{- end }}
              readOnly: true
            {{- end }}
            {{- with $c.persistence }}
            - { name: data, mountPath: {{ .mountPath }} }
            {{- end }}
      volumes:
        {{- range $c.emptyDirs }}
        - name: {{ .name }}
          emptyDir:
            {{- with .medium }}
            medium: {{ . }}
            {{- end }}
            sizeLimit: {{ .sizeLimit | default "64Mi" }}
        {{- end }}
        {{- range $c.files }}
        - name: {{ .name }}
          {{- if .configMap }}
          configMap: { name: {{ tpl .configMap $ctx }} }
          {{- else }}
          secret: { secretName: {{ tpl .secret $ctx }} }
          {{- end }}
        {{- end }}
  {{- if and (eq $kind "StatefulSet") $c.persistence }}
  volumeClaimTemplates:
    - metadata: { name: data }
      spec:
        accessModes: [ReadWriteOnce]
        {{- with $c.persistence.storageClass }}
        storageClassName: {{ . }}
        {{- end }}
        resources: { requests: { storage: {{ $c.persistence.size }} } }
  {{- end }}
{{- if $c.port }}
---
apiVersion: v1
kind: Service
metadata:
  name: {{ $name }}
  labels: {{- $labels | nindent 4 }}
spec:
  selector:
    app.kubernetes.io/name: {{ $name }}
    app.kubernetes.io/instance: {{ $ctx.Release.Name }}
  ports:
    - name: http
      port: {{ $c.port }}
      targetPort: http
{{- end }}
{{- with $c.pdb }}
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: {{ $name }}
  labels: {{- $labels | nindent 4 }}
spec:
  {{- toYaml . | nindent 2 }}
  selector:
    matchLabels:
      app.kubernetes.io/name: {{ $name }}
{{- end }}
{{- with $c.hpa }}
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: {{ $name }}
  labels: {{- $labels | nindent 4 }}
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: {{ $name }} }
  minReplicas: {{ .minReplicas }}
  maxReplicas: {{ .maxReplicas }}
  metrics:
    - type: Resource
      resource: { name: cpu, target: { type: Utilization, averageUtilization: {{ .cpu | default 70 }} } }
{{- end }}
{{- with $c.keda }}
{{- $sqs := printf "http://elasticmq.%s.svc.cluster.local:9324" $ctx.Release.Namespace }}
---
# Scales the worker on its queue depth (visible + in-flight), down to zero when idle.
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: {{ $name }}
  labels: {{- $labels | nindent 4 }}
spec:
  scaleTargetRef: { name: {{ $name }} }
  minReplicaCount: {{ .minReplicas | default 0 }}
  maxReplicaCount: {{ .maxReplicas }}
  pollingInterval: {{ .pollingInterval | default 5 }}
  cooldownPeriod: {{ .cooldownPeriod | default 60 }} # last replica -> 0 after this long without messages
  advanced:
    horizontalPodAutoscalerConfig:
      behavior:
        scaleUp: { stabilizationWindowSeconds: 0, policies: [{ type: Pods, value: 2, periodSeconds: 15 }] }
        scaleDown: { stabilizationWindowSeconds: 60, policies: [{ type: Pods, value: 1, periodSeconds: 30 }] }
  triggers:
    - type: aws-sqs-queue
      authenticationRef: { name: sqs-scaler }
      metadata:
        queueURL: {{ printf "%s/000000000000/%s" $sqs .queue | quote }}
        queueLength: {{ .targetPerReplica | default 1 | quote }} # messages per replica
        awsRegion: us-east-1
        awsEndpoint: {{ $sqs | quote }}
        scaleOnInFlight: "true" # a message being transcoded still needs its worker
{{- end }}
{{ include "sf-lib.networkPolicy" (dict "ctx" $ctx "name" $name "np" ($c.networkPolicy | default dict) "port" $c.port "metricsPort" $c.metricsPort) }}
{{- end }}

{{/* NetworkPolicy for one component; the namespace has a default-deny (sf-lib.defaultDeny). */}}
{{- define "sf-lib.networkPolicy" -}}
{{- $np := .np -}}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: {{ .name }}
  labels: {{- include "sf-lib.labels" . | nindent 4 }}
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: {{ .name }}
  policyTypes: [Ingress, Egress]
  ingress:
    {{- if $np.allowSelf }}
    - from: [{ podSelector: { matchLabels: { app.kubernetes.io/name: {{ .name }} } } }]
    {{- end }}
    {{- $obs := ($.ctx.Values.global | default dict).observability | default dict }}
    {{- if and $obs.enabled $.metricsPort }}
    - from: [{ namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: {{ $obs.namespace }} } } }]
      ports: [{ protocol: TCP, port: {{ $.metricsPort }} }] # Prometheus scrape
    {{- end }}
    {{- range $np.fromNamespaces }}
    - from: [{ namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: {{ . }} } } }]
      {{- if or $np.ports $.port }}
      ports:
        {{- range ($np.ports | default (list $.port)) }}
        - { protocol: TCP, port: {{ . }} }
        {{- end }}
      {{- end }}
    {{- end }}
    {{- range $np.from }}
    - from:
        {{- if eq . "ingress" }}
        - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: kube-system } }
          podSelector: { matchLabels: { app.kubernetes.io/name: traefik } }
        {{- else }}
        - podSelector: { matchLabels: { app.kubernetes.io/name: {{ . }} } }
        {{- end }}
      {{- if or $np.ports $.port }}
      ports:
        {{- range ($np.ports | default (list $.port)) }}
        - { protocol: TCP, port: {{ . }} }
        {{- end }}
      {{- end }}
    {{- end }}
  egress:
    - ports: [{ protocol: UDP, port: 53 }, { protocol: TCP, port: 53 }] # DNS
    {{- if $np.allowSelf }}
    - to: [{ podSelector: { matchLabels: { app.kubernetes.io/name: {{ .name }} } } }]
    {{- end }}
    {{- range $np.to }}
    - to:
        {{- if .cnpgCluster }}
        - podSelector: { matchLabels: { cnpg.io/cluster: {{ .cnpgCluster }} } }
        {{- else }}
        - podSelector: { matchLabels: { app.kubernetes.io/name: {{ .name }} } }
        {{- end }}
      ports: [{ protocol: TCP, port: {{ .port }} }]
    {{- end }}
    {{- if $obs.enabled }}
    - to: [{ namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: {{ $obs.namespace }} } } }]
      ports: [{ protocol: TCP, port: 4318 }] # OTLP traces to the collector
    {{- end }}
    {{- if $np.kubeApi }}
    - ports: [{ protocol: TCP, port: 443 }, { protocol: TCP, port: 6443 }] # Kubernetes API
    {{- end }}
{{- end }}

{{/* Deny all traffic in the namespace unless another policy allows it. */}}
{{- define "sf-lib.defaultDeny" -}}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-{{ .Release.Name }}
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/instance: {{ .Release.Name }}
  policyTypes: [Ingress, Egress]
{{- end }}

{{/* KEDA credentials for the SQS scaler (same keys the services use). */}}
{{- define "sf-lib.kedaAuth" -}}
---
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: sqs-scaler
spec:
  secretTargetRef:
    - { parameter: awsAccessKeyID, name: streamforge-s3, key: accessKey }
    - { parameter: awsSecretAccessKey, name: streamforge-s3, key: secretKey }
{{- end }}
