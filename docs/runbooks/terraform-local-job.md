# Runbook: the `terraform-local` Job fails or `helm upgrade` hangs on it

**Symptoms:** `make up-lite` / `make deploy` stops at `failed post-install: resource
Job/streamforge/terraform-local not ready`, or the Job's pods log
`Error acquiring the state lock`.

## 1. Find the first failure
`restartPolicy: Never` keeps every attempt's pod. Read the **oldest** one:
```bash
kubectl -n streamforge get pods -l app.kubernetes.io/name=terraform-local --sort-by=.metadata.creationTimestamp
kubectl -n streamforge logs <oldest-pod>
kubectl -n streamforge get events --sort-by=.lastTimestamp | grep -iE "evict|oom|kill"
```
Later attempts usually just report the lock the first one left behind.

| Cause seen | Fix |
|---|---|
| Exit 137 + event `Usage of EmptyDir volume "work" exceeds the limit` | `terraform init` unpacks the ~700 MB AWS provider into `/work`; keep its `sizeLimit` >= 2Gi |
| `Failed to read any lines from plugin's stdout` | the provider plugin needs a writable `/tmp` (read-only root filesystem) |
| `lookup registry.terraform.io ... network is unreachable` | the image must contain the provider mirror and set `TF_CLI_CONFIG_FILE` (`infra/terraform/Dockerfile`) |
| `Error acquiring the state lock` | a previous run was killed while holding the lock: step 2 |

## 2. Clear a stale state lock
Only once **no** terraform-local pod is running:
```bash
kubectl -n streamforge get lease lock-tfstate-default-streamforge-local -o yaml   # holder + time
kubectl -n streamforge delete lease lock-tfstate-default-streamforge-local
```
This is the `kubernetes` backend's equivalent of `terraform force-unlock`. The state
Secret (`tfstate-default-streamforge-local`) is untouched.

## 3. Recover the Helm release
An interrupted install/upgrade leaves the release `pending-install`/`pending-upgrade`:
```bash
helm -n streamforge history streamforge-deps
helm -n streamforge rollback streamforge-deps <last deployed revision>   # pending-upgrade
helm -n streamforge uninstall streamforge-deps                           # pending-install (first install)
kubectl -n streamforge delete job terraform-local --ignore-not-found
make deploy TAG=<the tag you pushed>   # `make images` prints it
```
