# Todos

A single-user Svelte 5, Node 24 and Express app with SQLite server storage, IndexedDB local storage, and a dedicated Web Worker for sync. There are no accounts or login.

## Run

```sh
./run.sh
```

Open http://127.0.0.1:3000. `run.sh` works from any directory, selects the Node version in `.nvmrc` when nvm is installed, installs dependencies if missing, builds the Svelte UI, and starts Express. Without nvm, put Node 24 on your PATH. Node 24.14.1 is recorded in `.nvmrc`.

You can also run `nvm use`, `npm install`, and `npm start` manually. `npm run dev` serves the Svelte sources through Vite middleware with hot updates, and restarts the server when its source changes. Both modes use the same origin and SQLite database.

The frontend is in `src/App.svelte`, `src/EntityRow.svelte`, and `src/CreationForm.svelte`. It uses Svelte 5 `$state`, `$derived`, and `$props` for page display and reactive editing, following the [Svelte reactivity documentation](https://svelte.dev/docs/svelte/$state). Shared storage and hierarchy code lives in `src/lib`; Vite also bundles the sync worker. The IndexedDB database name and schema stay the same, so existing local data and queued changes survive the frontend conversion. No component styles or UI styling packages are included. The minimal CSS in `public/reset.css` removes the body margin, sets a dark default theme, and gives buttons transparent backgrounds with subtle borders.

The server saves data in `data/todos.sqlite`. Configure `PORT`, `HOST`, or `DB_PATH` as needed. It binds to `127.0.0.1` by default. On a trusted LAN, run `HOST=0.0.0.0 ./run.sh` (add `--dev` for development) and open `http://<computer-LAN-IP>:3000` on devices using the same Wi-Fi. Devices using the same server sync their data. UUID generation uses native `crypto.randomUUID()` when available and falls back to UUID v4 using `crypto.getRandomValues()`, which also works on HTTP LAN origins, including Safari. See the [getRandomValues documentation](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/getRandomValues).

SQLite uses Node 24's built-in `node:sqlite` module, so no native npm addon is needed. Node 24.14.1 prints an experimental-feature notice for that module. See the [Node SQLite documentation](https://github.com/nodejs/node/blob/v24.14.1/doc/api/sqlite.md).

## Deployment

The sync API gives connected clients access to the same data. Keep the app on
localhost or a trusted private network. For remote access, require authentication
at the reverse proxy. See the [Caddy deployment guide](docs/caddy-deployment.md).

### Podman

The container build runs the Node test suite. The runtime runs as the non-root
`node` user. Mount a persistent volume for the SQLite database.

```sh
podman build -t localhost/todos:local .
podman volume create todos-data
podman run --rm --name todos \
  --publish 127.0.0.1:3000:3000 \
  --volume todos-data:/data \
  localhost/todos:local
```

Open http://127.0.0.1:3000. The base image version is pinned in `Containerfile`
and should match `.nvmrc`.

For an offline build, `Containerfile.offline` accepts preloaded `BUILD_IMAGE`
and `RUNTIME_IMAGE` build arguments. The build image must already have the locked
dependencies installed under `/app`.

## Use

The initial page contains notebooks, one per line. Click a notebook, folder, or list to replace the displayed contents with that item's children. Back moves up one level. Browser back and forward also work. Folders use 📁, lists use 📋, and notes use 📝. There are no page headings or margins. The default page font size is 125% of the browser's normal size. Dark mode is the default regardless of the operating system theme, including native form controls; buttons have transparent backgrounds.

HTTP/HTTPS URLs, `www` addresses and recognized bare domains in **todo and note text** become clickable links in contents, search results and favourites. URLs in notebook, folder and list names stay plain text within the usual navigation link. External links open a new tab with `noopener noreferrer`; other text in a favourite still opens its containing list. Surrounding punctuation stays outside the link, completed todo links retain strikethrough, and long URLs can wrap on narrow screens. Editing and storage remain plain text. Rendering escapes text rather than accepting HTML, and unsafe schemes such as `javascript:` and `data:` are never used as link destinations.

The text button beside **Back** shows the active sort and cycles through **Created desc**, **Created asc**, **Modified desc**, and **Modified asc** in entity views. Entity views initially default to **Created desc**. The notebook index and each notebook, folder, and list remember their own choice in SQLite through the regular local-first sync, including after server restarts and in other browsers. Sort changes do not change the content's modification timestamp. Search results use the current view's sort choice.

The matching text button **after Undo** cycles through **No date**, **Cr. Date**, **Cr. Time**, **Mod Date**, and **Mod Time**. Each notebook, folder, list and the notebook index independently saves its display choice in SQLite through IndexedDB and sync; existing views default to **No date**. The selected creation/modification date appears before each item's text, after its checkbox or type icon, for all five entity types. Date modes use `yyyy-mm-dd`; time modes use browser-local `yyyy-mm-dd HH:mm:ss` (24-hour). Search results use the current view's mode; favourites and pinned items never display dates or times. Trash and hashtag views share the notebook index's persisted choice; Trash also displays dates, while hashtags themselves have no entity timestamp to show. Display changes work offline, survive reload/server restart, sync across browsers, and do not modify content timestamps, sort preferences or Undo history.

Every entity has a ☆ button to toggle it as a favourite; ★ means selected. The same global favourites list appears above the creation controls on every page, below pinned items when present. It stays in creation-date descending order regardless of the current view's sort or search. Favourite notebooks, folders, and lists open directly; favourite notes and todos open their containing list. Stars save immediately through IndexedDB and sync to SQLite and other browsers. Renaming an item updates its favourite link, and trashed items disappear from favourites.

Every notebook, folder, list, note and todo can also be **pinned** with **📌**. Notes and todos expose Pin in their expandable read-only toolbar; notebooks, folders and lists show it among the icons to the right of their names. The global **pinned items** list appears above favourites on every page. Each pinned row has a pin on the left and uses the same navigation, text links, list counts and completed-todo display as favourites, without a favourite star. Click its pin to unpin it. Pinned items use creation-date descending order, independently of page sort/search. Pinning and favouriting are independent; an item can appear in both lists. Pins save immediately through IndexedDB and sync to SQLite and other browsers, work offline, and survive reload/server restart. Existing entities default to unpinned. Trash and hidden descendants are excluded; restoring them makes retained pins visible again. Pin toggles leave the current Undo action available.

List names are followed by their live count of **incomplete todos**: **⓪ ① ② ③ ④ ⑤ ⑥ ⑦ ⑧ ⑨ ⑩ ⑪ ⑫ ⑬ ⑭ ⑮ ⑯ ⑰ ⑱ ⑲ ⑳**. Counts above 20 use a sequence of circled digits (21 is **②①**), without capping the number. Only unchecked, non-trashed direct-child todos count; notes, completed todos, trash and invisible descendants do not. The badge appears in folder contents, search results, breadcrumbs, favourites, Trash names/location paths/restore messages and deletion confirmations. In contents, favourites and breadcrumb links, the badge sits outside the HTML anchor so link text remains clean. It is after the list name and before the star when present; favourite lists also place their star after the name/count. Counts update locally while offline and after sync, Undo, restore and reload. They are display-only: stored/editable names, hashtags, URLs, timestamps and preferences remain unchanged. Only lists receive badges, including **⓪** for empty or completed lists; deleted lists show **⓪** until restored. Circled numbers use a unified CJK/full-set font stack so **⓪** and **①**–**⑳** share identical glyph sizing.

A single shared **#** button on the breadcrumb line, immediately to the left of the first breadcrumb, opens **Hashtags** (`#hashtags`). It is not repeated beside each favourite, does not occupy a separate line, and stays available even when there are no favourites. This page lists every distinct hashtag from visible notebooks, folders, lists, notes and todos, one per line; trash and hidden descendants are excluded. The same favourites bar remains at the top when favourites exist. Its navigation row has **Back** and sort but **no Undo**, and creation/search controls are hidden. Sort cycles through **Alphabetical**, **Created desc**, **Created asc**, **Modified desc**, and **Modified asc**. **Alphabetical is reset on every visit and reload**, never saved as a preference. Tag creation dates use the earliest tagged item's creation date; modification dates use the latest tagged item's modification date. Clicking a hashtag opens matching items using the existing hashtag-prefix search; Back returns to the alphabetical index. Index changes follow local edits and sync automatically.

The **breadcrumbs bar** appears directly below favourites on every page. In entity views it starts with **Notebooks** and follows the current notebook/folder/list ancestry; click an ancestor to jump there and save pending edits. The current page is plain text. Trash shows only **Trash**, without a Notebooks prefix or separator; use **Back** to leave that view. Hashtag pages show only **Hashtags**, and hashtag search results add the selected tag. Regular search appends its query to the current path. Browser back/forward works with entity, hashtag-index and selected-tag bookmarks.

In entity views, the controls for adding items and searching locally stored items are always visible above the list. The **Back**, sort, and **Undo** row sits below **Search**, immediately above the displayed contents. Buttons use Unicode icons: ← for Back, ＋ for Add, ✎ for Edit, and 🗑︎ for Delete, with tooltips and accessible labels. **Sync now** and the sync status indicator are hidden for now; automatic background sync remains active. Notebooks contain folders; folders contain folders and lists; lists contain notes and todos. Folder views use icon radio buttons for 📁 Folder (selected by default) and 📋 List, with a 📅 button beside Add to create a list named with today's local date in `dd/mm/yyyy` format. Inside lists, icon radio buttons choose ☐ Todo (selected by default) or 📝 Note. Switching between types preserves the text being entered. Only the notebook index has a visible creation label, **New notebook**.

**Edit** expands a name input or text area with 60 columns, three times the default 20-column width, capped at the available screen width. New-item and Search fields keep their original sizes. Typing updates the displayed draft immediately; valid edits autosave to IndexedDB and signal background sync after two seconds without typing. Each keystroke restarts that timer, so only the latest draft is saved. Closing the editor or navigating away saves pending edits immediately. Checkboxes and **Add** still save immediately. Todos and lists have checkboxes for completion; completed items display with strikethrough styling. Creation and modification timestamps are stored for every item and appear in the text's hover tooltip.

Todo and note text is focusable as a single **read-only** unit using Tab or a tap/click. Notes and todos share a fixed-width column for their icon/checkbox, so their text and wrapped lines align on the left. Focus reveals a panel below the text with **Favourite**, **Edit**, **Delete**, and **Pin** in a toolbar; it does not open an editor or the mobile keyboard. Clicking or tapping the selected item's text again deselects it and collapses its panel/editor after saving pending edits, while leaving focus on the read-only text. Another click/tap reopens its panel. Selecting note or todo text with mouse drag allows highlighting, copying and pasting without toggling the toolbar. Only one of these panels is open per page, including search results. Focusing another item saves pending edits and closes the old panel/editor. **Edit** explicitly opens the existing editor inside that panel; **Close** saves and returns to its toolbar. Todo checkboxes remain beside the text, and embedded URL links retain their normal behavior without toggling panels. Navigation, removed search results and reload clear panel selection. Notebook/folder/list controls and Trash restore rows are unchanged.

Press **Enter** in the new-item field to add the item, or in an editor to save immediately and close it, including on mobile software keyboards. Fields request a **Done** key where supported. Mobile line-break input events are treated as acceptance even without a normal keydown; non-cancellable inserted newlines are removed before accepting the original text. Physical **Shift+Enter** still inserts a line break in note and todo text areas, and pasted multiline text is preserved. Enter used to confirm an active IME composition does not submit prematurely. Names remain single-line. Empty names stay in the editor for correction.

On desktop, opening a page automatically focuses its new-item field, including when navigating Back or using browser history. On devices with a coarse primary pointer, such as phones and tablets, page loading and navigation leave the input unfocused so the on-screen keyboard stays closed. Tapping an input or Edit still starts typing normally. Background sync preserves the current typing focus.

Search uses IndexedDB without a server request. Plain words match text without regard to case; multiple words must all match. Hashtags match prefixes as you type, also without regard to case: `#wo` finds `#work` and `#workout`. Hashtags support Unicode letters, numbers, underscores and hyphens. Search spans notebooks, folders, lists, notes, and todos. **Open list** takes a note or todo search result to its containing list.

**Delete** moves an item and all its descendants to trash. Deleting a notebook, folder, or list opens a confirmation naming the item and explaining that its contents will also move to trash. Cancel keeps the item and any pending edits. Notes and todos delete immediately. SQLite and the synced IndexedDB snapshot retain those records; normal contents, search, favourites and hashtags hide them.

The single **🗑︎ Trash** button beside **#** on the breadcrumb line opens `#trash`. It lists all deleted notebooks, folders, lists, notes and todos, one per line with their original locations. Favourites and breadcrumbs remain at the top; **Back** returns to the previous view. Creation/search and Undo are hidden. The sort button defaults to **Trashed desc** on entry/reload and also offers Trashed asc and the four creation/modification orders, without changing saved entity sort preferences. **↥ Restore** returns an item to its original parent and restores children deleted by the same operation, preserving IDs, text, checked status, favourites and creation dates. Items already trashed earlier remain there. Restore a deleted parent first; blocked rows explain which parent needs restoring. Restore works after reloading, queues locally while offline, and syncs to other browsers. Missing parent/deletion information disables restore rather than sending an invalid mutation. There is no permanent-delete action.

The ↶ button to the right of the sort button undoes name/text edits, checkbox changes, or deletions, keeping up to 50 steps in the current browser tab's session. Autosaves during one uninterrupted editor session form one step, returning to the text from before that session. Closing and reopening an editor starts a new step; an intervening undoable action also separates steps to preserve their order. Undo handles typing still waiting for the two-second autosave and closes the editor. Undoing a container deletion restores the children deleted by that same operation, preserving their IDs, favourites, checked state, and creation dates; items already in trash before that deletion stay there. Undo saves locally and syncs to other browsers. Undo clicks need not be consecutive: navigating and searching keep the history available, and a new undoable change goes on top of the remaining history. Adding items, sorting, changing date display, and toggling favourites or pins leave the history intact. A manual Restore removes the corresponding deletion steps while preserving earlier edits. The button's tooltip shows the number of saved steps; it is disabled when there is nothing to undo. Reloading clears the history, and each tab keeps its own history.

After an online visit on HTTPS (or localhost), the production build caches the files it needs to reopen or reload offline. Todos can be installed from supporting browsers. While offline, the app uses data already saved in IndexedDB and queues edits there. The sync worker retries with exponential backoff and attempts immediately when the connection returns while the app is open.

## Nearby errands and locations

The shared **🚗** button immediately to the right of **#** opens **Nearby errands** (`#nearby`). **Edit locations** opens the location editor (`#locations`). Both support bookmarks, browser history and Back, and retain the favourites and breadcrumbs.

After deploying this feature, reload existing app tabs before adding or importing locations so the UI and sync worker both load the updated location model.

Locations have a name containing zero or more hashtags, decimal latitude/longitude and an **Available as current location** toggle. Every physical branch is a separate location; many branches can share hashtags, and one branch can have several. Locations are separate from notebooks, folders, lists, notes and todos, and do not appear in their ordinary search, favourites or hashtag index. In the editor, expand a location's name to edit or delete it. Edits to names, coordinates and the toggle are saved together with **Save location**. Search, an All/User/Deleted filter and 50-row pages support large collections. Deletion is soft: deleted locations stop matching and disappear from origin pills; expand one under **Deleted locations** to restore it. Restoring does not select it as the current origin.

Choose a current location from pills for locations with the toggle enabled. The distance pills are **2 km**, **5 km**, **10 km**, **20 km** and **No filter**. The initial radius is **5 km**, with no selected origin. Locations, origin and radius persist in SQLite through the same IndexedDB/worker sync as other app data; they work offline, survive reload/server restart and sync across browsers. Deleting or disabling the selected origin clears the selection. User locations can also be destinations, including matching their own tags at zero distance.

Nearby errands includes all five visible entity types, excluding trash, hidden descendants and completed entities (including completed todos and lists). For Nearby errands matching, notes and todos use their own hashtags plus the hashtags on their immediate parent list. Matching requires any **exact, case-insensitive shared hashtag** with a saved location inside the chosen radius. Distance is straight-line GPS distance and includes the radius boundary. **#errand**, including when inherited from a list, always includes an otherwise eligible entity, bypassing location and distance requirements even when it has other tags. Without an origin, a radius shows only #errand and a selection prompt; **No filter** shows all location-tag matches plus #errand, while unmatched entities remain excluded.

Each matching entity appears once, without location names, distances or matching-location panels. The breadcrumb is **Nearby errands**, with **Edit locations** appended in the location editor. Distance pills stay enabled while choices save locally; rapid selections are saved in order. Results sort by nearest qualifying location, then alphabetically, followed by entities included solely through #errand; No filter without an origin sorts everything alphabetically. Existing entity panels, editing, checkboxes, favourites, Open list, Undo and the root date-display preference remain available.

The location editor imports prepared JSON with a preview of additions, updates, unchanged records and previous values. Imports merge by stable IDs and retain locations absent from the file. The whole operation validates before writing, rejects deleted/colliding IDs and detects changes since the preview. **Export JSON** downloads every active origin and destination, independent of search/filter/page; it omits origin selection and radius. See the [JSON format and merge rules](docs/locations-json.md) and [example file](docs/locations.example.json). The example branches are illustrative; supply your own verified coordinates.

The **Added via UI only** checkbox in Edit locations shows locations originally created using Add location. It combines with search and the Show dropdown, including deleted locations, and defaults off on entry. Creation source persists through editing, importing updates, deletion, restoration and sync; editing an imported location does not make it UI-created. Existing locations recover their original source from SQLite history. Export always includes all active locations and omits internal creation-source metadata.

Location names allow 5,000 characters so large shopping-centre hashtag collections can be imported and edited.

## Move items to another list

Inside a list, open **⋯** beside **↶ Undo** and choose **Move items to next day / list**. Date shortcuts use the date in the current list's name or today's local date. You can edit the destination name to reuse an existing list in the same folder or create a new one. **Incomplete** selects unchecked todos. Use **Selected** or **All** to move notes and completed todos too.

The move leaves you on the source list with an **Open list** shortcut. One **Undo** returns the moved items and removes the newly created destination from the folder if it is empty.

In the same **⋯** menu, **Hide controls** leaves the new-item row and the list visible. Use **←** in the new-item row to go back to the folder, or **⋯** to show the controls temporarily. Use **×** to hide them again. Leaving or reloading the list ends the temporary reveal. The checkbox syncs per list, and moving items copies its saved value to the destination list.

## Sync protocol

1. A UI mutation atomically updates the local `entities` projection and appends a mutation to the IndexedDB `outbox`. Each mutation has a UUID operation ID; a creation also has a UUID entity ID. Updates contain only changed fields, so a text edit does not overwrite a checkbox change.
2. The UI signals the dedicated module worker. The worker reads up to 100 queued mutations plus its last server revision and checkpoint, then sends `POST /api/sync` with `{ cursor, checkpoint, mutations, awaiting }`. It caps batches at one megabyte and sends an individual mutation above that size on its own. The server sends the latest committed revision over the `/api/events` WebSocket so browsers can pull immediately. Tabs use Web Locks where available to coordinate each request and skip revisions already saved by another tab. The server sends heartbeats every four seconds. The browser pulls when the socket opens, when an established socket closes, or after ten seconds of silence. A ten-second poll runs while the socket is unavailable. BroadcastChannel keeps tabs on the same origin current.
3. In one SQLite transaction the server checks hierarchy and fields, applies mutations in their received order, assigns timestamps, records durable operation receipts, and appends full entity snapshots to a revision log. A retried operation returns its original receipt and does not apply twice. Operation IDs cannot be reused for different payloads.
4. The response contains `{ acknowledgements, changes, cursor, checkpoint, hasMore }`. Each accepted receipt carries the revision through which its effect is recorded. While the browser is still downloading that revision, it checks the receipt using the operation ID in `awaiting` before sending later edits. If the receipt is missing after a backup restore, the browser sends the original edit again. A pull page contains up to 500 changes and 512 KiB of change data. A single larger change gets its own page. If a page ends inside a deletion, restore, or location import, the server returns the operation ID and its final revision in `operationId` and `operationThrough`. A receiving browser downloads through that revision before showing the operation. The worker keeps syncing until both pull pages and the outbox are drained, and retries a request after 15 seconds without upload or download progress.
5. A single IndexedDB transaction applies new snapshots to `canonical`, advances the cursor, and drops acknowledged mutations only once the pull cursor includes their revision. It rebuilds the UI projection from canonical data plus remaining local mutations when a response brings changes or receipts. Edits queued during a network round trip therefore survive reconciliation. Older responses from another tab cannot move the cursor or canonical data backwards.
6. The last new edit accepted by the server wins for overlapping fields. Retries do not gain a new position in that order. Trash takes precedence over stale edits and creations under trashed parents. These mutations receive explicit rejection receipts and are removed from the outbox. Tabs share rejection alerts, and dismissing an alert clears only the rejections displayed in that tab. Deleted items do not reappear through stale edits.

SQLite is authoritative. Client timestamps are only provisional until the server accepts a mutation. Change history, receipts, and trash are retained; no history compaction is implemented. Keep the SQLite file and its WAL together when taking a live backup, or stop the server before copying the database. If a browser’s checkpoint is missing or belongs to a history replaced by a backup restore, the server requests a fresh download before accepting queued edits. The browser keeps its previous view available during the download, replaces it when the download completes, and then submits its preserved outbox.

## Verify

```sh
npm test
npx playwright install chromium
npm run test:browser
```

The Node tests check server persistence, hierarchy validation, hashtags, idempotent retries, field conflicts, cascade trash, paginated pull, HTTP behavior, and IndexedDB reconciliation during concurrent edits. Browser tests check drill-down, reactive editors, checkboxes, search, trash, network interruptions, and sync between two independent browser profiles. Browser tests use a separate in-memory SQLite server on port 3100, leaving your data untouched.

Browser storage behavior follows the transaction model documented in [Using IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB), and sync runs in a [Web Worker](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers).

## License

The application code is available under the [MIT License](LICENSE).
