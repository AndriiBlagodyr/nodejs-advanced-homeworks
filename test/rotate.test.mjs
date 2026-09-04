import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('rotation restores the database password when the secret update fails', () => {
  const directory = mkdtempSync(join(tmpdir(), 'password-rotation-'));
  const binDirectory = join(directory, 'bin');
  const secretFile = join(directory, 'db_password');
  const callsFile = join(directory, 'docker-calls');
  const dockerMock = join(binDirectory, 'docker');
  const opensslMock = join(binDirectory, 'openssl');

  mkdirSync(binDirectory);
  writeFileSync(secretFile, 'old-password\n');
  writeFileSync(
    dockerMock,
    `#!/bin/sh
cat >/dev/null
printf 'call\\n' >> "$FAKE_DOCKER_CALLS"
if [ "$(wc -l < "$FAKE_DOCKER_CALLS")" -eq 1 ]; then
  rm -f "$TEST_SECRET_FILE"
  mkdir "$TEST_SECRET_FILE"
fi
exit 0
`,
  );
  chmodSync(dockerMock, 0o755);
  writeFileSync(opensslMock, '#!/bin/sh\nprintf "new-password"\n');
  chmodSync(opensslMock, 0o755);

  try {
    const result = spawnSync('bash', [resolve('rotate.sh')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DB_PASSWORD_FILE: secretFile,
        FAKE_DOCKER_CALLS: callsFile,
        TEST_SECRET_FILE: secretFile,
        PATH: `${binDirectory}${delimiter}${process.env.PATH}`,
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /Secret update failed; restoring the previous database password/,
    );
    assert.equal(readFileSync(callsFile, 'utf8'), 'call\ncall\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
