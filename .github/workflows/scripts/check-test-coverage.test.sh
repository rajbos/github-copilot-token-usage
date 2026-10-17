#!/usr/bin/env bash
# Scenario tests for check-test-coverage.sh using isolated temp git repos.
# Run by the test-coverage-check job in ci.yml. Locally: bash .github/workflows/scripts/check-test-coverage.test.sh
set -euo pipefail   # a failing setup step must fail the run, not be skipped
SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-test-coverage.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAILS=0

LOGIC=$'export function a(x: number) {\n  return x + 1;\n}\nexport function b(x: number) {\n  return x * 2;\n}\nexport function c(x: number) {\n  return x - 3;\n}\nexport function d(x: number) {\n  return x / 4;\n}\n'

new_repo() {
  local d="$TMP/$1"; mkdir -p "$d/src" "$d/vscode-extension/test/unit"; cd "$d"
  git init -q . && git config user.email t@t && git config user.name t && git config commit.gpgsign false
  printf "import { z } from './oldName';\n%s" "$LOGIC" > src/a.ts
  printf "%s" "$LOGIC" > src/oldName.ts
  printf "import { a } from './oldName';\nexport const k = a(1);\n" > src/user.ts
  git add -A && git commit -qm base
}

# expect <name> <exit-code>
expect() {
  local out rc
  if out="$(BASE_SHA="$(git rev-parse HEAD~1)" HEAD_SHA="$(git rev-parse HEAD)" PR_BODY="${PR_BODY:-}" bash "$SCRIPT" 2>&1)"; then rc=0; else rc=$?; fi
  if [ "$rc" = "$2" ]; then echo "ok   - $1"; else echo "FAIL - $1 (exit $rc, wanted $2)"; echo "$out" | sed 's/^/       /'; FAILS=$((FAILS+1)); fi
}
commit() { git add -A && git commit -qm change; }

new_repo del;       git rm -q src/oldName.ts; commit;                                   expect "deletion-only" 0
new_repo del2;      printf "%s" "$LOGIC" > src/a.ts; commit;                            expect "deleted import line only" 0
new_repo ren100;    git mv src/oldName.ts src/newName.ts; commit;                       expect "100% rename" 0
new_repo renlogic;  git mv src/oldName.ts src/newName.ts; echo 'export const sneaky = () => fetch("x");' >> src/newName.ts; commit; expect "rename + logic edit" 1
new_repo renexport; git mv src/oldName.ts src/newName.ts; echo 'export const mode = "new";' >> src/newName.ts; commit; expect "rename + exported string constant" 1
new_repo renimp;    mkdir -p src/sub; git mv src/a.ts src/sub/a.ts; sed -i "s#'./oldName'#'../oldName'#" src/sub/a.ts; commit; expect "rename moving dir + re-pointed import" 0
new_repo renreexp;  git mv src/oldName.ts src/newName.ts; echo "export { q } from './other';" >> src/newName.ts; commit; expect "rename + fresh re-export" 1
new_repo renfresh;  git mv src/oldName.ts src/newName.ts; echo "import './sideEffect';" >> src/newName.ts; commit; expect "rename + fresh side-effect import" 1
new_repo importfresh; git mv src/oldName.ts src/newName.ts; echo "import { n } from './newName';" >> src/user.ts; commit; expect "importer gains a fresh import" 1
new_repo moveIn;    mkdir -p examples; git mv src/oldName.ts examples/oldName.ts; commit; git mv examples/oldName.ts src/moved.ts; commit; expect "move from outside src/ into src/" 1
new_repo samebase;  mkdir -p src/first src/second; echo 'export const T = 1;' > src/first/types.ts; echo 'export const T = 2;' > src/second/types.ts; echo "import { T } from './first/types';" > src/use.ts; git add -A; git commit -qm more; sed -i "s#./first/types#./second/types#" src/use.ts; commit; expect "same-basename module swap" 1
new_repo extswap;   echo 'export const T = 1;' > src/mod.js; echo 'export const T = 2;' > src/mod.ts; echo "import { T } from './mod.js';" > src/use.ts; git add -A; git commit -qm more; sed -i "s#./mod.js#./mod.ts#" src/use.ts; commit; expect "explicit extension swap .js -> .ts" 1
new_repo posexp;    printf "export { a } from './oldName';
" > src/user.ts; git add -A; git commit -qm more; git mv src/oldName.ts src/newName.ts; sed -i "s#./oldName#./newName#" src/user.ts; commit; expect "export-from path update after rename" 0
new_repo posreq;    printf "const o = require('./oldName');
" > src/user.ts; git add -A; git commit -qm more; git mv src/oldName.ts src/newName.ts; sed -i "s#./oldName#./newName#" src/user.ts; commit; expect "require path update after rename" 0
new_repo aboveroot; printf "import { s } from '../../shared';
" > src/user.ts; git add -A; git commit -qm more; sed -i "s#../../shared#../../../shared#" src/user.ts; commit; expect "parent path beyond repo root" 1
new_repo binrename; head -c 64 /dev/urandom > src/blob.ts; git add -A; git commit -qm more; git mv src/blob.ts src/blob2.ts; printf '\0x' >> src/blob2.ts; commit; expect "binary source rename" 1
new_repo idxrename; mkdir src/adapters; printf "%s" "$LOGIC" > src/adapters/index.ts; printf "import { a } from './adapters';\n" > src/user.ts; git add -A; git commit -qm more; git mv src/adapters src/adapters2; sed -i "s#./adapters'#./adapters2'#" src/user.ts; commit; expect "renamed directory index + importer" 0
new_repo plusplus;  printf '++ /* c */ counter;\n' >> src/user.ts; commit; expect "added line that looks like a +++ header" 1
new_repo stemclash; echo 'export const o = 1;' > src/old.ts; echo 'export const o = 2;' > src/old.js; printf "import { o } from './old';\n" > src/user.ts; git add -A; git commit -qm more; git mv src/old.js src/new.js; sed -i "s#'./old'#'./new'#" src/user.ts; commit; expect "extensionless import with competing stem" 1
new_repo wsswap;    printf "import { w } from './foo  bar';\n" > src/user.ts; git add -A; git commit -qm more; sed -i "s#'./foo  bar'#'./foo bar'#" src/user.ts; commit; expect "specifier whitespace change" 1
new_repo baddiff;   echo 'export const x = 1;' >> src/a.ts; commit
if BASE_SHA=0000000000000000000000000000000000000001 HEAD_SHA="$(git rev-parse HEAD)" bash "$SCRIPT" >/dev/null 2>&1; then echo "FAIL - unreadable diff must fail closed"; FAILS=$((FAILS+1)); else echo "ok   - unreadable diff fails closed"; fi
new_repo spaces;    printf "import { s } from 'd.ts';\n" > src/user.ts; printf '%s' "$LOGIC" > "src/a b.ts"; git add -A; git commit -qm more; git mv "src/a b.ts" "src/c d.ts"; sed -i "s#'d.ts'#'./c'#" src/user.ts; commit; expect "renamed path with spaces does not alias a bare import" 1
new_repo spaces2;   printf "import { s } from './a b';\n" > src/user.ts; printf '%s' "$LOGIC" > "src/a b.ts"; git add -A; git commit -qm more; git mv "src/a b.ts" "src/c d.ts"; sed -i "s#'./a b'#'./c d'#" src/user.ts; commit; expect "path with spaces: genuine rename + importer" 0
new_repo dts;       printf '%s' "$LOGIC" > src/old.d.ts; printf "import { a } from './old';\n" > src/user.ts; git add -A; git commit -qm more; git mv src/old.d.ts src/new.d.ts; sed -i "s#'./old'#'./new'#" src/user.ts; commit; expect ".d.ts rename + extensionless importer" 0
new_repo dtsclash;  printf '%s' "$LOGIC" > src/old.d.ts; echo 'export const o = 1;' > src/old.ts; printf "import { a } from './old';\n" > src/user.ts; git add -A; git commit -qm more; git mv src/old.d.ts src/new.d.ts; sed -i "s#'./old'#'./new'#" src/user.ts; commit; expect ".d.ts rename with competing old.ts" 1
new_repo testmove;  mkdir -p src/test; printf '%s' "$LOGIC" > src/test/helper.ts; git add -A; git commit -qm more; git mv src/test/helper.ts src/helper.ts; commit; expect "test file moved into production" 1
new_repo importer;  git mv src/oldName.ts src/newName.ts; sed -i "s#./oldName#./newName#" src/user.ts; commit; expect "rename + importer path update" 0
new_repo importbad; git mv src/oldName.ts src/newName.ts; sed -i "s#./oldName#./elsewhere#" src/user.ts; commit; expect "import swapped to non-renamed module" 1
new_repo plain;     echo 'export const x = 1;' >> src/a.ts; commit;                     expect "plain source change, no test" 1
new_repo withtest;  echo 'export const x = 1;' >> src/a.ts; echo t > vscode-extension/test/unit/a.test.ts; commit; expect "source change with test" 0
new_repo skip;      echo 'export const x = 1;' >> src/a.ts; commit; PR_BODY="[skip-test-check] layout" expect "[skip-test-check] marker" 0

[ "$FAILS" = 0 ] && echo "all passed" || { echo "$FAILS failed"; exit 1; }
