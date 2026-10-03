
/**
 * PocketBase Migration: Initialize OBPB Backup Collections & Views
 */
migrate((app) => {
    const snapshot = [
        {
            "id": "obpb_objects",
            "name": "objects",
            "type": "base",
            "fields": [
                {
                    "id": "objects__id",
                    "autogeneratePattern": "[a-z0-9]{15}",
                    "name": "id",
                    "pattern": "^[a-z0-9]+$",
                    "primaryKey": true,
                    "required": true,
                    "system": true,
                    "type": "text"
                },
                {
                    "id": "objects__user",
                    "name": "user",
                    "type": "relation",
                    "required": true,
                    "collectionId": "_pb_users_auth_",
                    "cascadeDelete": false,
                    "maxSelect": 1
                },
                {
                    "id": "objects__vault",
                    "name": "vault",
                    "type": "text",
                    "required": true
                },
                {
                    "id": "objects__hash",
                    "name": "hash",
                    "type": "text",
                    "required": true
                },
                {
                    "id": "objects__parent_hash",
                    "name": "parent_hash",
                    "type": "text",
                    "required": false
                },
                {
                    "id": "objects__type",
                    "name": "type",
                    "type": "select",
                    "required": true,
                    "maxSelect": 1,
                    "values": [
                        "snapshot",
                        "diff"
                    ]
                },
                {
                    "id": "objects__data",
                    "name": "data",
                    "type": "text",
                    "required": false,
                    "max": 5000000
                },
                {
                    "id": "objects__data_hash",
                    "name": "data_hash",
                    "type": "text",
                    "required": true
                },
                {
                    "id": "objects__diff_format",
                    "name": "diff_format",
                    "type": "text",
                    "required": false
                },
                {
                    "id": "objects__encoding",
                    "name": "encoding",
                    "type": "text",
                    "required": false
                },
                {
                    "id": "objects__size",
                    "name": "size",
                    "type": "number",
                    "required": false,
                    "onlyInt": true,
                    "min": 0
                },
                {
                    "id": "objects__created",
                    "name": "created",
                    "type": "autodate",
                    "onCreate": true,
                    "onUpdate": false,
                    "system": true
                },
                {
                    "id": "objects__updated",
                    "name": "updated",
                    "type": "autodate",
                    "onCreate": true,
                    "onUpdate": true,
                    "system": true
                }
            ],
            "indexes": [
                "CREATE INDEX `idx_objects_user_vault_hash` ON `objects` (`user`, `vault`, `hash`)",
                "CREATE INDEX `idx_objects_parent_hash` ON `objects` (`parent_hash`)",
                "CREATE INDEX `idx_objects_user` ON `objects` (`user`)"
            ],
            "listRule": "@request.auth.id != \"\" && user = @request.auth.id",
            "viewRule": "@request.auth.id != \"\" && user = @request.auth.id",
            "createRule": "@request.auth.id != \"\" && @request.body.user = @request.auth.id"
        },
        {
            "id": "obpb_entries",
            "name": "entries",
            "type": "base",
            "fields": [
                {
                    "id": "entries__id",
                    "autogeneratePattern": "[a-z0-9]{15}",
                    "name": "id",
                    "pattern": "^[a-z0-9]+$",
                    "primaryKey": true,
                    "required": true,
                    "system": true,
                    "type": "text"
                },
                {
                    "id": "entries__user",
                    "name": "user",
                    "type": "relation",
                    "required": true,
                    "collectionId": "_pb_users_auth_",
                    "cascadeDelete": false,
                    "maxSelect": 1
                },
                {
                    "id": "entries__vault",
                    "name": "vault",
                    "type": "text",
                    "required": true
                },
                {
                    "id": "entries__path",
                    "name": "path",
                    "type": "text",
                    "required": true
                },
                {
                    "id": "entries__old_path",
                    "name": "old_path",
                    "type": "text",
                    "required": false
                },
                {
                    "id": "entries__object_id",
                    "name": "object_id",
                    "type": "relation",
                    "required": true,
                    "collectionId": "obpb_objects",
                    "cascadeDelete": false,
                    "maxSelect": 1
                },
                {
                    "id": "entries__hash",
                    "name": "hash",
                    "type": "text",
                    "required": true
                },
                {
                    "id": "entries__operation",
                    "name": "operation",
                    "type": "select",
                    "required": true,
                    "maxSelect": 1,
                    "values": [
                        "save",
                        "rename",
                        "delete"
                    ]
                },
                {
                    "id": "entries__device",
                    "name": "device",
                    "type": "text",
                    "required": true
                },
                {
                    "id": "entries__timestamp",
                    "name": "timestamp",
                    "type": "number",
                    "required": true,
                    "onlyInt": true
                },
                {
                    "id": "entries__created",
                    "name": "created",
                    "type": "autodate",
                    "onCreate": true,
                    "onUpdate": false,
                    "system": true
                },
                {
                    "id": "entries__updated",
                    "name": "updated",
                    "type": "autodate",
                    "onCreate": true,
                    "onUpdate": true,
                    "system": true
                }
            ],
            "indexes": [
                "CREATE INDEX `idx_entries_user_vault_path_tz` ON `entries` (`user`, `vault`, `path`, `timestamp` DESC)",
                "CREATE INDEX `idx_entries_user` ON `entries` (`user`)",
                "CREATE INDEX `idx_entries_hash` ON `entries` (`hash`)"
            ],
            "listRule": "@request.auth.id != \"\" && user = @request.auth.id",
            "viewRule": "@request.auth.id != \"\" && user = @request.auth.id",
            "createRule": "@request.auth.id != \"\" && @request.body.user = @request.auth.id"
        },
        {
            "id": "obpb_entries_with_objects",
            "name": "entries_with_objects",
            "type": "view",
            "listRule": "@request.auth.id != \"\" && user = @request.auth.id",
            "viewRule": "@request.auth.id != \"\" && user = @request.auth.id",
            "viewQuery": "SELECT entries.id AS id, entries.user AS user, entries.vault AS vault, entries.path AS path, entries.old_path AS old_path, entries.operation AS operation, entries.device AS device, entries.timestamp AS timestamp, objects.hash AS hash, objects.parent_hash AS parent_hash, objects.type AS type, objects.data AS data, objects.data_hash AS data_hash, objects.diff_format AS diff_format, objects.size AS size FROM entries JOIN objects ON entries.object_id = objects.id"
        },
        {
            "id": "obpb_latest_vault_files",
            "name": "latest_vault_files",
            "type": "view",
            "listRule": "@request.auth.id != \"\" && user = @request.auth.id",
            "viewRule": "@request.auth.id != \"\" && user = @request.auth.id",
            // Old
            // "viewQuery": "WITH ranked_entries AS (SELECT entries.id, entries.user, entries.vault, entries.path, entries.operation, entries.timestamp, entries.hash, entries.object_id, ROW_NUMBER() OVER (PARTITION BY entries.user, entries.vault, entries.path ORDER BY entries.timestamp DESC) AS rn FROM entries) SELECT id, user, vault, path, operation, timestamp, hash, object_id FROM ranked_entries WHERE rn = 1"
            "viewQuery": "SELECT entries.id, entries.user, entries.vault, entries.path, entries.operation, MAX(entries.timestamp) AS timestamp, entries.hash, entries.object_id FROM entries GROUP BY entries.user, entries.vault, entries.path"
        },
        {
            "id": "obpb_vault_stats",
            "name": "vault_stats",
            "type": "view",
            "listRule": "@request.auth.id != \"\" && user = @request.auth.id",
            "viewRule": "@request.auth.id != \"\" && user = @request.auth.id",
            "viewQuery": "SELECT MIN(o.vault) AS id, o.user AS user, o.vault AS vault, COUNT(*) AS total_objects, COALESCE(e.total_entries, 0) AS total_entries, SUM(CASE WHEN o.type = 'snapshot' THEN 1 ELSE 0 END) AS snapshot_count, SUM(CASE WHEN o.type = 'diff' THEN 1 ELSE 0 END) AS diff_count, COALESCE(SUM(o.size), 0) AS total_bytes, COALESCE(SUM(CASE WHEN o.type = 'snapshot' THEN o.size ELSE 0 END), 0) AS snapshot_bytes, COALESCE(SUM(CASE WHEN o.type = 'diff' THEN o.size ELSE 0 END), 0) AS diff_bytes FROM objects AS o LEFT JOIN (SELECT user, vault, COUNT(*) AS total_entries FROM entries GROUP BY user, vault) AS e ON o.user = e.user AND o.vault = e.vault GROUP BY o.user, o.vault"
        }
    ];

    if (typeof app?.importCollections === 'function') {
        return app.importCollections(snapshot, false);
    }
    if (typeof Dao !== 'undefined') {
        return Dao(app).importCollections(snapshot, false);
    }
    return importCollections(snapshot, false, app);
}, (app) => {
    const revertCollections = [
        "entries_with_objects",
        "latest_vault_files",
        "vault_stats",
        "entries",
        "objects"
    ];

    for (const name of revertCollections) {
        try {
            const collection = typeof app?.findCollectionByNameOrId === 'function'
                ? app.findCollectionByNameOrId(name)
                : (typeof Dao !== 'undefined' ? Dao(app).findCollectionByNameOrId(name) : null);

            if (collection) {
                if (typeof app?.delete === 'function') {
                    app.delete(collection);
                } else if (typeof Dao !== 'undefined') {
                    Dao(app).deleteCollection(collection);
                }
            }
        } catch {
            // Ignore if collection already removed
        }
    }
});
