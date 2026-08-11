# publisher-action

@README.md

## Environment

The toolchain comes from [devbox.json](devbox.json), with pnpm provided by
corepack. `direnv` activates it automatically.

## Checks

`pnpm check` formats, then runs `test:static` and `test`. It rewrites formatting
locally and only verifies it when `CI` is set.

## dist/ is committed

`pnpm package` bundles each stage with ncc. The `.husky/pre-commit` hook runs it
and stages `dist/`, so local commits stay in sync.
