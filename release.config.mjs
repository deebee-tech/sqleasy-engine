export default {
  branches: [
    'main',
    { name: 'beta', prerelease: true },
    { name: 'alpha', prerelease: true },
    { name: 'next', prerelease: true },
  ],
  plugins: [
    // Default Angular parser rejects `feat!:`; conventionalcommits supports it.
    ['@semantic-release/commit-analyzer', { preset: 'conventionalcommits' }],
    ['@semantic-release/release-notes-generator', { preset: 'conventionalcommits' }],
    ['@semantic-release/changelog', { changelogFile: 'CHANGELOG.md' }],
    // Keep jsr.json's version in lockstep with the release.
    [
      'semantic-release-replace-plugin',
      {
        replacements: [
          {
            files: ['jsr.json'],
            from: '"version": ".*"',
            to: '"version": "${nextRelease.version}"',
            results: [{ file: 'jsr.json', hasChanged: true, numMatches: 1, numReplacements: 1 }],
            countMatches: true,
          },
        ],
      },
    ],
    // Publish from the repo ROOT — `files: ["dist"]` ships the tsdown build, and the exports already
    // point at `./dist/...`. No pkgRoot / path-strip dance (unlike the zero-dep sibling packages).
    '@semantic-release/npm',
    ['@semantic-release/git', { assets: ['CHANGELOG.md', 'package.json', 'jsr.json'] }],
    // Registries BEFORE the GitHub release, so a GitHub-plugin hiccup can't block JSR. JSR
    // authenticates via OIDC from the release workflow (id-token: write) — no token needed.
    '@sebbo2002/semantic-release-jsr',
    '@semantic-release/github',
  ],
};
