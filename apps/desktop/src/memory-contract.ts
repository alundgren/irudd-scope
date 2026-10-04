import { Schema } from "effect";
import { MemoryConfiguration } from "@irudd-scope/protocol/memory";
import type { RetroConfiguration, RetroDestination } from "@irudd-scope/protocol/retro";

/** A machine's last observed personal bundle, kept so retro destinations survive brief disconnects. */
export const MemoryBundle = Schema.Struct({
  root: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  verifiedAt: Schema.String.check(Schema.isMaxLength(40)),
});
export const MemoryPreferences = Schema.Struct({
  ...MemoryConfiguration.fields,
  bundles: Schema.Record(Schema.String, MemoryBundle),
});
export type MemoryPreferences = typeof MemoryPreferences.Type;
export const emptyMemoryPreferences = (): MemoryPreferences => ({
  enabled: false,
  repository: null,
  bundles: {},
});
export const LOCAL_MEMORY_MACHINE = "local";
const GENERATED = "okf-personal-";

export function withoutMemoryDestinations<T extends RetroConfiguration>(configuration: T): T {
  return {
    ...configuration,
    memory: {
      ...configuration.memory,
      destinations: configuration.memory.destinations.filter(
        (destination) => !destination.id.startsWith(GENERATED),
      ),
    },
  };
}

/** Offers each synced personal bundle as an operator destination; hides OKF while memory is off. */
export function withMemoryDestinations(
  configuration: RetroConfiguration,
  memory: MemoryPreferences,
): RetroConfiguration {
  const saved = withoutMemoryDestinations(configuration).memory.destinations.filter(
    (destination) => memory.enabled || destination.type !== "okf",
  );
  const generated: RetroDestination[] = [];
  if (memory.enabled && memory.repository)
    for (const source of configuration.sources) {
      const machine =
        source.location?.type === "desktop"
          ? LOCAL_MEMORY_MACHINE
          : source.location?.type === "remote"
            ? source.location.remoteId
            : undefined;
      const bundle = machine === undefined ? undefined : memory.bundles[machine];
      if (bundle)
        generated.push({
          id: `${GENERATED}${source.id}`.slice(0, 256),
          type: "okf",
          scope: "operator",
          sourceId: source.id,
          path: bundle.root,
          available: true,
          verifiedAt: bundle.verifiedAt,
        });
    }
  return {
    ...configuration,
    memory: { ...configuration.memory, destinations: [...saved, ...generated] },
  };
}
