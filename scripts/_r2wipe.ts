// TEMP — wipe viral-engine test namespaces from the shared bucket (NOT redesigns/). Delete after.
import { deletePrefix } from "../packages/storage/src";

for (const p of ["longforms/", "renders/", "thumbs/", "campaigns/"]) {
  await deletePrefix(p);
  console.log(`wiped ${p}`);
}
console.log("done (redesigns/ untouched)");
process.exit(0);
