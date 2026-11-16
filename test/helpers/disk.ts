import type { StatfsReader } from "../../src/ops/host-resources";

/** 50 of 100 GiB free (4 KiB blocks): a daemon test never meets `disk_low` because of the machine's real disk. */
export const ROOMY_STATFS: StatfsReader = () => ({ bavail: 50 * 262_144, blocks: 100 * 262_144, bsize: 4096 });
