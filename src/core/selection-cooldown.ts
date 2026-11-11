export interface RankedSelectionCandidate<T> {
  id: string;
  score: number;
  value: T;
  weight?: number;
}

export interface SelectionCooldownRecord {
  selectedSinceMs?: number;
  lastDroppedAtMs?: number;
}

export interface SelectionCooldownDecision<T> {
  selected: T[];
  selectedIds: string[];
  retainedIds: string[];
  newIds: string[];
  droppedIds: string[];
  forcedHoldIds: string[];
  blockedReentryIds: string[];
}

export class SelectionCooldownState {
  private readonly records = new Map<string, SelectionCooldownRecord>();

  apply<T>(
    rankedCandidates: readonly RankedSelectionCandidate<T>[],
    options: {
      currentSelectedIds: ReadonlySet<string>;
      maxSelectedWeight: number;
      nowMs?: number;
      minHoldMs: number;
      reentryCooldownMs: number;
    }
  ): SelectionCooldownDecision<T> {
    const nowMs = options.nowMs ?? Date.now();
    const rankedIds = rankedCandidates.map((candidate) => candidate.id);
    const rankIndexById = new Map(rankedIds.map((id, index) => [id, index]));
    const candidateById = new Map(rankedCandidates.map((candidate) => [candidate.id, candidate]));
    const blockedReentryIds: string[] = [];

    const eligibleCandidates = rankedCandidates.filter((candidate) => {
      if (options.currentSelectedIds.has(candidate.id)) {
        return true;
      }

      const record = this.records.get(candidate.id);

      if (
        record?.lastDroppedAtMs &&
        nowMs - record.lastDroppedAtMs < options.reentryCooldownMs
      ) {
        blockedReentryIds.push(candidate.id);
        return false;
      }

      return true;
    });

    const getWeight = (id: string): number => Math.max(candidateById.get(id)?.weight ?? 1, 1);
    const getSelectedWeight = (ids: readonly string[]): number =>
      ids.reduce((total, id) => total + getWeight(id), 0);
    const selectedIds: string[] = [];
    const selectedIdSet = new Set(selectedIds);
    const forcedHoldIds: string[] = [];

    for (const candidate of eligibleCandidates) {
      const nextWeight = getSelectedWeight(selectedIds) + Math.max(candidate.weight ?? 1, 1);

      if (selectedIds.length > 0 && nextWeight > options.maxSelectedWeight) {
        continue;
      }

      if (nextWeight > options.maxSelectedWeight) {
        continue;
      }

      selectedIds.push(candidate.id);
      selectedIdSet.add(candidate.id);
    }

    for (const currentId of options.currentSelectedIds) {
      if (selectedIdSet.has(currentId)) {
        continue;
      }

      const record = this.records.get(currentId);

      if (!record?.selectedSinceMs) {
        continue;
      }

      if (nowMs - record.selectedSinceMs >= options.minHoldMs) {
        continue;
      }

      if (!candidateById.has(currentId)) {
        continue;
      }

      selectedIds.push(currentId);
      selectedIdSet.add(currentId);
      forcedHoldIds.push(currentId);
    }

    while (getSelectedWeight(selectedIds) > options.maxSelectedWeight) {
      const forcedHoldSet = new Set(forcedHoldIds);
      const removableId = [...selectedIds]
        .filter((id) => !forcedHoldSet.has(id))
        .sort(
          (left, right) =>
            (rankIndexById.get(right) ?? Number.MAX_SAFE_INTEGER) -
            (rankIndexById.get(left) ?? Number.MAX_SAFE_INTEGER)
        )[0];

      if (!removableId) {
        break;
      }

      selectedIds.splice(selectedIds.indexOf(removableId), 1);
      selectedIdSet.delete(removableId);
    }

    const finalSelectedIds = selectedIds.sort(
      (left, right) =>
        (rankIndexById.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (rankIndexById.get(right) ?? Number.MAX_SAFE_INTEGER)
    );
    const finalSelectedIdSet = new Set(finalSelectedIds);
    const retainedIds = finalSelectedIds.filter((id) => options.currentSelectedIds.has(id));
    const newIds = finalSelectedIds.filter((id) => !options.currentSelectedIds.has(id));
    const droppedIds = [...options.currentSelectedIds].filter((id) => !finalSelectedIdSet.has(id));

    for (const id of finalSelectedIds) {
      const previous = this.records.get(id);
      this.records.set(id, {
        selectedSinceMs:
          options.currentSelectedIds.has(id) && previous?.selectedSinceMs
            ? previous.selectedSinceMs
            : nowMs,
        lastDroppedAtMs: previous?.lastDroppedAtMs
      });
    }

    for (const id of droppedIds) {
      const previous = this.records.get(id);
      this.records.set(id, {
        selectedSinceMs: undefined,
        lastDroppedAtMs: nowMs
      });

      if (!previous) {
        this.records.set(id, {
          selectedSinceMs: undefined,
          lastDroppedAtMs: nowMs
        });
      }
    }

    return {
      selected: finalSelectedIds
        .map((id) => candidateById.get(id)?.value)
        .filter((value): value is T => value !== undefined),
      selectedIds: finalSelectedIds,
      retainedIds,
      newIds,
      droppedIds,
      forcedHoldIds,
      blockedReentryIds
    };
  }
}
