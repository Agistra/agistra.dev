Supports law: Known Trap — `gh` 401 despite valid auth.

# Why `gh` returns 401 while `gh auth status` is valid

Cause: a stale `GITHUB_TOKEN` environment variable in the shell overrides the keyring credential — `gh` prefers the env var unconditionally.
