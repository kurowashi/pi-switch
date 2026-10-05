import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root, derived from this file: test/helpers/ -> ../.. */
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
