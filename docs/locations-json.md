# Location JSON files

Use **Nearby errands → Edit locations → Import JSON** to choose a prepared JSON file. The complete file is validated before a preview is shown. Review additions, updates, unchanged records and the previous values of updated records, then choose **Apply import**. Cancel leaves saved locations unchanged.

[locations.example.json](locations.example.json) is a complete example. Its coordinates illustrate the format and do not identify verified retail branches. Replace them with your own locations.

```json
{
  "version": 1,
  "locations": [
    {
      "id": "my-source-woolworths-richmond",
      "name": "Example Woolworths #woolworths #supermarket",
      "latitude": -37.82,
      "longitude": 144.97,
      "userLocation": false
    }
  ]
}
```

Each record requires exactly these fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Stable, case-sensitive ID: 1–100 ASCII letters, digits, underscores or hyphens. Keep the same ID for the same physical location in every file. `root-view-settings` is reserved. |
| `name` | string | Nonblank name, at most 5,000 characters. Include zero or more hashtags directly in this name. This allows shopping centres to match large retailer collections. |
| `latitude` | number | Decimal latitude, from −90 to 90 inclusive. South is negative. |
| `longitude` | number | Decimal longitude, from −180 to 180 inclusive. West is negative. |
| `userLocation` | boolean | `true` makes this location available as a current-location pill. It can still be a matching destination. |

Coordinates use normal GPS latitude/longitude in decimal degrees. Numbers and booleans must be JSON values, not quoted strings. Unknown fields, duplicate IDs and unsupported file versions are rejected. JSON does not allow comments or trailing commas. Import at most **5,000 locations** and **5 MiB** per file; split larger collections into files with different location IDs.

Hashtags are derived from `name`; do not provide a separate `tags` field. They use the app's existing Unicode letters/numbers, underscore and hyphen rules. Matching is exact and case-insensitive. Multiple branches can share `#supermarket`, and one branch can have both `#woolworths` and `#supermarket`. Any shared hashtag qualifies. Use only `#woolworths` on a task that specifically requires Woolworths.

## Merge behavior

- A new ID adds a location. IDs already used by notebooks or other app items are rejected.
- A matching active location ID updates its name, coordinates and user-location toggle, preserving its creation date.
- Identical records are shown as unchanged and do not create new revisions.
- Locations absent from the file remain saved. An import never treats absence as deletion.
- A matching deleted location blocks the import. Restore it in the editor's **Deleted locations** filter first, or use a different ID if this is a different location.
- A location changed after the preview invalidates the whole import. Preview the file again to review the newer values. This is also checked by the server when an offline import syncs.
- Selected origin and radius are preserved. If an update turns off the selected origin's `userLocation`, the origin is cleared; the radius remains saved.

Prefix IDs with a stable source name when generating files from different sources. Names alone are not used for deduplication: different branches can have the same name, and a branch's name can change. Two different IDs remain two different locations even if their names and coordinates coincide.

Imports are one atomic queued operation and use the existing browser/SQLite sync. A rejected concurrent import is rolled back during reconciliation and reported in the app. Large imports are pulled across sync pages without losing the local projection, and retrying a lost response does not apply the import twice.

## Export and recovery

**Added via UI only** in Edit locations hides locations originally created by JSON import. It combines with Search and the Show dropdown, including User locations and Deleted locations, and resets pagination when changed. “User locations” means eligible current-location origins; it is independent of how a location was created.

Creation source is saved internally in SQLite and synced to browsers. Editing an imported location in the UI keeps its imported origin; updating a UI-created location through JSON keeps its UI origin. Deleting/restoring also preserves origin. Existing records are upgraded from their earliest saved history, including imports edited before this feature. If creation history is unavailable, the surviving import marker is used, otherwise the record is treated as UI-created. The filter defaults off when opening the editor.

**Export JSON** downloads all active locations, including origins and destinations, independent of the editor's search, filter or current page. The file excludes selected origin, radius, internal timestamps, creation source, derived tags and deleted locations. It uses the same version 1 format and preserves IDs for reimporting. Importing an exported location into another database creates an imported location there; matching IDs in the original database retain their creation source.

Deleting a location is reversible. Use **Show → Deleted locations**, expand the location and choose **Restore location**. Deleted locations do not match errands or appear as origins. Restoring a location does not automatically select it as the current location.
