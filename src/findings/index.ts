import type { Block, Finding } from "../types.js";
import type { Config } from "../config.js";
import type { Tokenizer } from "../tokenizer.js";
import { findDuplication } from "./duplication.js";
import { findValueConflicts } from "./valueConflict.js";
import { findVehicleFit } from "./vehicleFit.js";

const TYPE_ORDER: Record<Finding["type"], number> = {
  duplication: 0,
  "value-conflict": 1,
  "vehicle-fit": 2,
};
const SEV_ORDER: Record<string, number> = { error: 0, warn: 1, off: 2 };

export function runFindings(
  blocks: Block[],
  config: Config,
  tok: Tokenizer,
): Finding[] {
  const all = [
    ...findDuplication(blocks, config, tok),
    ...findValueConflicts(blocks, config, tok),
    ...findVehicleFit(blocks, config, tok),
  ];
  all.sort(
    (a, b) =>
      SEV_ORDER[a.severity]! - SEV_ORDER[b.severity]! ||
      TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
      (b.tokens ?? 0) - (a.tokens ?? 0) ||
      (a.locations[0]!.file < b.locations[0]!.file ? -1 : 1),
  );
  return all;
}
