/** True when the tests run as root: mode bits (0o000 files, read-only dirs) do not stop root, so those tests skip. */
export const isRoot = process.getuid?.() === 0;
