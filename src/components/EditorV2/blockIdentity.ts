// Block identity: keeping a block's id in step with the key it is stored under.
//
// Kept apart from blockStack so it can be unit tested: blockStack reaches into
// the React layer for StackEntry, which the ts-node script config cannot load.

import { runInAction } from "mobx";
import { Block } from "@/src/types/Block";
import type { Layer } from "@/src/types/Layer";
import type { Store } from "@/src/types/Store";

/**
 * Make every block's id match the key it is stored under, and unique.
 *
 * `BlockMap` is keyed by id, and `removeBlock` deletes `map.delete(block.id)`.
 * So a block whose id no longer matches its key CANNOT BE DELETED: the map is
 * asked for a key it does not hold and the removal silently does nothing,
 * while the editor's own list drops the row and the save writes the block
 * straight back. The pattern "comes back" on every reload.
 *
 * The disagreement survives a round trip, because `BlockMap.deserialize` keys
 * by the serialized key while `Block.deserialize` takes the id from the block,
 * so a file that has it keeps it forever. This reconciles on load: the key
 * wins, since that is the identity the map actually operates on, and a block
 * whose id is already taken is given a fresh one rather than dropped.
 *
 * Returns how many blocks were repaired, so a caller can save the repair.
 */
export const reconcileBlockIds = (store: Store): number => {
  let repaired = 0;
  // `Layer` is structural and does not expose its map; only the V2 layer has
  // one, and repairing keys is the one job that genuinely needs it.
  const mapOf = (layer: Layer): Map<string, Block> | undefined =>
    (layer as unknown as { blockMap?: { map?: Map<string, Block> } }).blockMap
      ?.map;

  runInAction(() => {
    for (const layer of store.layers) {
      const blockMap = mapOf(layer);
      if (!blockMap) continue;
      const entries = [...blockMap.entries()];
      const taken = new Set<string>();
      for (const [key, block] of entries) {
        const wanted = taken.has(key) ? `${key}-${taken.size}` : key;
        taken.add(wanted);
        if (block.id !== wanted) {
          block.id = wanted;
          repaired++;
        }
        if (wanted !== key) {
          blockMap.delete(key);
          blockMap.set(wanted, block);
        }
      }
    }
  });
  return repaired;
};
