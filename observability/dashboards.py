#!/usr/bin/env python3
# Generates observability/chart/files/dashboards/*.json (run: make dashboards). Edit this,
# not the JSON.
import json, os
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "chart", "files", "dashboards")
os.makedirs(out, exist_ok=True)

PROM = {"type": "prometheus", "uid": "prometheus"}
LOKI = {"type": "loki", "uid": "loki"}
TEMPO = {"type": "tempo", "uid": "tempo"}
NS = 'namespace="$namespace"'

_id = [0]
def panel(kind, title, x, y, w, h, targets, ds=PROM, unit=None, extra=None, desc=None):
    _id[0] += 1
    p = {"id": _id[0], "type": kind, "title": title, "datasource": ds,
         "gridPos": {"x": x, "y": y, "w": w, "h": h}, "targets": targets,
         "fieldConfig": {"defaults": {}, "overrides": []}, "options": {}}
    if unit:
        p["fieldConfig"]["defaults"]["unit"] = unit
    if desc:
        p["description"] = desc
    if extra:
        for k, v in extra.items():
            p[k] = v
    return p

def prom(expr, legend, ref="A"):
    return {"refId": ref, "datasource": PROM, "expr": expr, "legendFormat": legend}

def stat(title, x, expr, color_on_nonzero=None, unit=None):
    p = panel("stat", title, x, 9, 6, 4, [prom(expr, "", "A")], unit=unit)
    p["options"] = {"colorMode": "background" if color_on_nonzero else "value", "graphMode": "none", "reduceOptions": {"calcs": ["lastNotNull"]}}
    steps = [{"color": "green", "value": None}]
    if color_on_nonzero:
        steps.append({"color": color_on_nonzero, "value": 1})
    p["fieldConfig"]["defaults"]["thresholds"] = {"mode": "absolute", "steps": steps}
    return p

def dashboard(uid, title, panels, desc):
    return {
        "uid": uid, "title": title, "description": desc, "tags": ["streamforge"], "timezone": "browser",
        "schemaVersion": 39, "version": 1, "refresh": "10s", "time": {"from": "now-30m", "to": "now"},
        "templating": {"list": [{
            "name": "namespace", "label": "Namespace", "type": "query", "datasource": PROM,
            # kube-state-metrics series always exist; our own gauges can briefly vanish under load
            "query": {"query": 'label_values(kube_namespace_status_phase{namespace=~"streamforge.*"}, namespace)', "refId": "ns"},
            "definition": 'label_values(kube_namespace_status_phase{namespace=~"streamforge.*"}, namespace)', "refresh": 1,
            "current": {"text": "streamforge", "value": "streamforge"}}]},
        "panels": panels,
    }

# ---- Pipeline overview -------------------------------------------------------------
scaling = panel("timeseries", "Queue depth vs worker replicas (KEDA autoscaling)", 0, 0, 24, 9, [
    prom(f'max by (queue) (sum by (queue, pod) (streamforge_queue_messages{{{NS}, dlq="false", queue=~"probe|transcode|thumbnail", state=~"visible|in_flight"}}))', "{{queue}} queue", "A"),
    prom(f'sum by (deployment) (kube_deployment_status_replicas{{{NS}, deployment=~".+-worker"}})', "{{deployment}} replicas", "B"),
], desc="Messages waiting or in flight per pipeline queue (left axis) and the replicas KEDA runs for each worker (right axis, dashed). Workers scale from 0 when work arrives and back to 0 after the cooldown.")
scaling["fieldConfig"]["defaults"]["custom"] = {"lineWidth": 2, "fillOpacity": 10, "lineInterpolation": "stepAfter", "spanNulls": True}
scaling["fieldConfig"]["overrides"] = [{
    "matcher": {"id": "byFrameRefID", "options": "B"},
    "properties": [{"id": "custom.axisPlacement", "value": "right"}, {"id": "custom.lineStyle", "value": {"fill": "dash", "dash": [10, 6]}},
                   {"id": "custom.fillOpacity", "value": 0}, {"id": "custom.axisLabel", "value": "replicas"}, {"id": "decimals", "value": 0}]}]
scaling["options"] = {"legend": {"displayMode": "table", "placement": "right", "calcs": ["max", "lastNotNull"]}, "tooltip": {"mode": "multi"}}

jobs = panel("timeseries", "Jobs per second by task and outcome", 0, 13, 12, 8, [
    prom(f'sum by (task, outcome) (rate(streamforge_jobs_total{{{NS}}}[1m]))', "{{task}} {{outcome}}")], unit="ops")
dur = panel("timeseries", "Job duration p50 / p95 (successful)", 12, 13, 12, 8, [
    prom(f'histogram_quantile(0.95, sum by (le, task) (rate(streamforge_job_duration_seconds_bucket{{{NS}, outcome="success"}}[5m])))', "{{task}} p95", "A"),
    prom(f'histogram_quantile(0.50, sum by (le, task) (rate(streamforge_job_duration_seconds_bucket{{{NS}, outcome="success"}}[5m])))', "{{task}} p50", "B"),
], unit="s")
traces = panel("table", "Recent transcode traces (click a trace ID)", 0, 21, 12, 9, [
    {"refId": "A", "datasource": TEMPO, "queryType": "traceql", "limit": 20,
     "query": '{ resource.deployment.environment = "$namespace" && name = "transcode process" }'}], ds=TEMPO,
    desc="Each video is one trace: upload complete (catalog-api) -> SNS -> probe -> transcode / thumbnail -> job status.")
traces["transformations"] = [{"id": "organize", "options": {"excludeByName": {"nested": True}}}]
logs = panel("logs", "Warnings and errors", 12, 21, 12, 9, [
    {"refId": "A", "datasource": LOKI,
     "expr": '{k8s_namespace_name="$namespace", k8s_deployment_name=~".+"} |~ "(?i)\\"level\\":(\\"(warn|error)\\"|[45]0)"'}], ds=LOKI)
logs["options"] = {"showTime": True, "wrapLogMessage": True, "sortOrder": "Descending", "enableLogDetails": True}

pipeline = dashboard("streamforge-pipeline", "StreamForge / Pipeline", [
    scaling,
    stat("Videos ready", 0, f'max(streamforge_videos{{{NS}, status="READY"}})'),
    stat("Processing", 6, f'max(streamforge_videos{{{NS}, status=~"UPLOADED|PROCESSING"}}) or vector(0)'),
    stat("Failed videos", 12, f'max(streamforge_videos{{{NS}, status="FAILED"}}) or vector(0)', "orange"),
    stat("Dead-lettered messages", 18, f'sum(max by (queue) (streamforge_queue_messages{{{NS}, dlq="true"}})) or vector(0)', "red"),
    jobs, dur, traces, logs,
], "Queue depth vs autoscaled workers, throughput, latency, traces and logs for the video pipeline.")

# ---- Services RED ------------------------------------------------------------------
red = dashboard("streamforge-services", "StreamForge / Services (RED)", [
    panel("timeseries", "catalog-api request rate by route", 0, 0, 12, 8, [
        prom(f'sum by (route) (rate(http_request_duration_seconds_count{{{NS}, route!~"/metrics|/healthz|/readyz"}}[1m]))', "{{route}}")], unit="reqps"),
    panel("timeseries", "catalog-api error ratio (5xx)", 12, 0, 6, 8, [
        prom(f'sum(rate(http_request_duration_seconds_count{{{NS}, status_code=~"5.."}}[5m])) / clamp_min(sum(rate(http_request_duration_seconds_count{{{NS}}}[5m])), 1e-9)', "5xx ratio")], unit="percentunit"),
    panel("timeseries", "catalog-api p95 latency by route", 18, 0, 6, 8, [
        prom(f'histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket{{{NS}, route!~"/metrics|/healthz|/readyz"}}[5m])))', "{{route}}")], unit="s"),
    panel("timeseries", "Worker failures and retries", 0, 8, 12, 8, [
        prom(f'sum by (task, outcome) (rate(streamforge_jobs_total{{{NS}, outcome!="success"}}[5m]))', "{{task}} {{outcome}}")], unit="ops"),
    panel("timeseries", "Job-status events applied", 12, 8, 6, 8, [
        prom(f'sum by (outcome) (rate(streamforge_job_status_events_total{{{NS}}}[5m]))', "{{outcome}}")], unit="ops"),
    panel("timeseries", "Live SSE clients", 18, 8, 6, 8, [
        prom(f'sum(streamforge_sse_clients{{{NS}}})', "clients")]),
    panel("timeseries", "Memory by pod", 0, 16, 12, 8, [
        prom(f'sum by (pod) (container_memory_working_set_bytes{{{NS}, container!="", container!="POD"}})', "{{pod}}")], unit="bytes"),
    panel("timeseries", "CPU by pod", 12, 16, 12, 8, [
        prom(f'sum by (pod) (rate(container_cpu_usage_seconds_total{{{NS}, container!="", container!="POD"}}[2m]))', "{{pod}}")], unit="cores"),
], "Rate, errors and duration for catalog-api and the pipeline workers, plus resource usage per pod.")

for name, d in [("streamforge-pipeline.json", pipeline), ("streamforge-services.json", red)]:
    json.dump(d, open(os.path.join(out, name), "w"), indent=1)
print("ok", len(pipeline["panels"]), len(red["panels"]))
