#!/usr/bin/env bash
# Installs pinned dev tools into ~/.local (no sudo). Verifies SHA-256 of every download.
# System packages (make, ffmpeg) are installed separately with apt; see README.
set -euo pipefail

GO_VERSION=1.27.3
NODE_VERSION=26.13.0
PNPM_VERSION=12.18.0
KUBECTL_VERSION=1.37.2
HELM_VERSION=4.3.1
K3D_VERSION=5.9.0
K6_VERSION=2.3.0
JQ_VERSION=1.8.2
TERRAFORM_VERSION=1.17.1

# apt prerequisites (need sudo, so we only check them)
missing=""
for p in make ffmpeg unzip libatomic1; do dpkg -s $p >/dev/null 2>&1 || missing="$missing $p"; done
if [ -n "$missing" ]; then
  echo "Missing system packages:$missing" >&2
  echo "Run: sudo apt update && sudo apt install -y$missing" >&2
  exit 1
fi

PREFIX="$HOME/.local"; BIN="$PREFIX/bin"; OPT="$PREFIX/opt"
mkdir -p "$BIN" "$OPT"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
cd "$TMP"

fetch() { curl -fsSL --retry 3 -o "$2" "$1"; }
# verify <file> <expected-sha256>
verify() { [ -n "$2" ] && echo "$2  $1" | sha256sum -c --quiet - || { echo "checksum mismatch: $1" >&2; exit 1; }; }
# sum_from <sums-file> <filename>
sum_from() { awk -v f="$2" '{n=$2; sub(/^\*/,"",n); sub(/^.*\//,"",n)} n==f {print $1; exit}' "$1"; }

echo "go $GO_VERSION"
f=go$GO_VERSION.linux-amd64.tar.gz
fetch https://dl.google.com/go/$f $f; verify $f "$(curl -fsSL https://dl.google.com/go/$f.sha256)"
rm -rf "$OPT/go"; tar -C "$OPT" -xzf $f
ln -sf "$OPT/go/bin/go" "$OPT/go/bin/gofmt" "$BIN/"

echo "node $NODE_VERSION"
f=node-v$NODE_VERSION-linux-x64.tar.xz
fetch https://nodejs.org/dist/v$NODE_VERSION/$f $f; fetch https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt node.sums
verify $f "$(sum_from node.sums $f)"
rm -rf "$OPT/node"; mkdir -p "$OPT/node"; tar -C "$OPT/node" --strip-components=1 -xJf $f
export PATH="$OPT/node/bin:$BIN:$PATH"   # npm's shebang needs node on PATH
"$OPT/node/bin/npm" install -g --silent pnpm@$PNPM_VERSION
for b in node npm npx pnpm pnpx; do [ -e "$OPT/node/bin/$b" ] && ln -sf "$OPT/node/bin/$b" "$BIN/$b"; done

echo "kubectl $KUBECTL_VERSION"
u=https://dl.k8s.io/release/v$KUBECTL_VERSION/bin/linux/amd64/kubectl
fetch $u kubectl; verify kubectl "$(curl -fsSL $u.sha256)"; install -m755 kubectl "$BIN/"

echo "helm $HELM_VERSION"
f=helm-v$HELM_VERSION-linux-amd64.tar.gz
fetch https://get.helm.sh/$f $f; verify $f "$(curl -fsSL https://get.helm.sh/$f.sha256sum | awk '{print $1}')"
tar -xzf $f; install -m755 linux-amd64/helm "$BIN/"

echo "k3d $K3D_VERSION"
r=https://github.com/k3d-io/k3d/releases/download/v$K3D_VERSION
fetch $r/k3d-linux-amd64 k3d-linux-amd64; fetch $r/checksums.txt k3d.sums
verify k3d-linux-amd64 "$(sum_from k3d.sums k3d-linux-amd64)"; install -m755 k3d-linux-amd64 "$BIN/k3d"

echo "k6 $K6_VERSION"
r=https://github.com/grafana/k6/releases/download/v$K6_VERSION; f=k6-v$K6_VERSION-linux-amd64.tar.gz
fetch $r/$f $f; fetch $r/k6-v$K6_VERSION-checksums.txt k6.sums
verify $f "$(sum_from k6.sums $f)"; tar -xzf $f; install -m755 k6-v$K6_VERSION-linux-amd64/k6 "$BIN/"

echo "jq $JQ_VERSION"
r=https://github.com/jqlang/jq/releases/download/jq-$JQ_VERSION
fetch $r/jq-linux-amd64 jq-linux-amd64; fetch $r/sha256sum.txt jq.sums
verify jq-linux-amd64 "$(sum_from jq.sums jq-linux-amd64)"; install -m755 jq-linux-amd64 "$BIN/jq"

echo "terraform $TERRAFORM_VERSION"
r=https://releases.hashicorp.com/terraform/$TERRAFORM_VERSION; f=terraform_${TERRAFORM_VERSION}_linux_amd64.zip
fetch $r/$f $f; fetch $r/terraform_${TERRAFORM_VERSION}_SHA256SUMS tf.sums
verify $f "$(sum_from tf.sums $f)"
python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extract('terraform','.')" $f; install -m755 terraform "$BIN/"

# PATH for login shells
grep -q 'streamforge-tools' "$HOME/.profile" || cat >> "$HOME/.profile" <<'P'
# streamforge-tools
export PATH="$HOME/.local/bin:$HOME/go/bin:$PATH"
P
echo "done. open a new shell or run: source ~/.profile"
