export const CURRENT_CONFIG_SCHEMA_VERSION = 2;

type ConfigObject = Record<string, unknown>;

function parseSchemaVersion(value: unknown): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return 0;
	return value;
}

function migrateV0ToV1(config: ConfigObject): ConfigObject {
	// Introduce explicit schema versioning for override files.
	return {
		...config,
		schemaVersion: 1,
	};
}

function migrateV1ToV2(config: ConfigObject): ConfigObject {
	const next: ConfigObject = { ...config, schemaVersion: 2 };
	const steering = next.steering;
	if (steering && typeof steering === "object" && !Array.isArray(steering)) {
		const { maxAcceptedExamples: _removed, ...rest } = steering as ConfigObject & { maxAcceptedExamples?: unknown };
		next.steering = rest;
	}
	return next;
}

export function migrateOverrideConfig(config: ConfigObject): {
	config: ConfigObject;
	changed: boolean;
	fromVersion: number;
	toVersion: number;
} {
	const fromVersion = parseSchemaVersion(config.schemaVersion);
	if (fromVersion > CURRENT_CONFIG_SCHEMA_VERSION) {
		return {
			config,
			changed: false,
			fromVersion,
			toVersion: fromVersion,
		};
	}

	let changed = false;
	let current = fromVersion;
	let migrated: ConfigObject = { ...config };

	while (current < CURRENT_CONFIG_SCHEMA_VERSION) {
		switch (current) {
			case 0:
				migrated = migrateV0ToV1(migrated);
				current = 1;
				changed = true;
				break;
			case 1:
				migrated = migrateV1ToV2(migrated);
				current = 2;
				changed = true;
				break;
			default:
				throw new Error(`No config migration path from schema version ${current} to ${CURRENT_CONFIG_SCHEMA_VERSION}.`);
		}
	}

	return {
		config: migrated,
		changed,
		fromVersion,
		toVersion: current,
	};
}
