# Changesets

Only the SDK, `@barry-rocks/sdk`, is versioned here: `config.json` ignores every other workspace package. Changesets writes the SDK's version and changelog, and nothing else. It never publishes and never tags: Barry is local only for now, and a release's version is its `v0.10.0-beta.N` tag. Do not run `changeset publish`, `changeset git-tag`, `changeset pack` or `changeset pre`.

## When a change needs a changeset

A change to a stable SDK entry (see [the SDK's entry points](../sdk/README.md#entry-points)) needs one. While the SDK is below 1.0:

- `minor`: the change can break code that uses the entry;
- `patch`: an addition or a fix.

`major` (1.0) is the author's decision, not a routine bump. A change only to internal entries, tests, docs or build scripts needs none.

```sh
pnpm changeset add --minor @barry-rocks/sdk -m "What changed, and what code using it should do."
```

Without the flags, `changeset add` asks questions. The summary becomes the changelog line: say what changed for code that uses the SDK, and what to do about it.

`pnpm changeset status --since master` fails a branch that changes the SDK's source, generated files or `package.json` without adding a changeset. If such a branch changes nothing a bag can see, add an empty one: `pnpm changeset add --empty -m "Internal entries only."`

## Cutting a release

Before tagging `v0.10.0-beta.N`:

1. Run `pnpm changeset status --verbose`. If it lists no bump, tag as usual.
2. Run `pnpm changeset version`. It writes the SDK's version and `CHANGELOG.md`, and deletes the changesets it used.
3. Commit the SDK's `package.json` and `CHANGELOG.md` and the `.changeset` folder, naming those paths, as `chore(sdk): version <version>`.
4. Tag that commit, and build the release from the tag.
