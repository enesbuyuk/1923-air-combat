# Sourced by the deploy scripts: loads .env (if present) and checks the required variables.
# Values already set in the environment (e.g. CI build variables) take precedence.

if [[ -f .env ]]; then
  # `|| -n $key` keeps a last line that has no trailing newline.
  while IFS='=' read -r key value || [[ -n "$key" ]]; do
    value="${value%$'\r'}"
    [[ -z "$key" || "$key" == \#* ]] && continue
    [[ -z "${!key:-}" ]] && export "$key=$value"
  done < .env
fi

: "${R2_BUCKET:?R2_BUCKET is not set; add R2_BUCKET=<bucket name> to .env or the environment}"
if [[ ! "$R2_BUCKET" =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]]; then
  echo "R2_BUCKET is not a valid R2 bucket name: $R2_BUCKET" >&2
  exit 1
fi
