# Backup plugin for storing Obsidian notes in PocketBase (SQLite database)

Versioned remote backups and restoration for Obsidian notes using the PocketBase API and its embedded SQLite database.

## Core Principles

1. **Your local vault is always the single source of truth.** Backups are pushed strictly one-way from Obsidian to PocketBase. PocketBase will never overwrite your local notes automatically.
2. **Everything runs client-side.** Diff calculations and version checks occur entirely with the Obsidian plugin; PocketBase serves purely as secure remote storage.
3. **Pushes only:** The plugin never pulls dataautomatically. Restoring notes requires explicit user action, such as recovering an item from the trash or selecting a revision in the note history view.

## Backup events

Automatic vault events - modification, renames, and deletions - are mirrored to the remote instance. For modifications, each entry stores a content-derived snapshot or diff that links the current version to its predecessor. Historical versions can be viewed in the right sidebar of a note.

The left sidebar provides a plugin ribbon icon with with three actions for the active note:
- Snapshot now: Immediately pushes a full copy of the active note to the server.
- Sync now: Checks whether an earlier version exists on the server. If found, it calculates and uploads only the diff. If the note is new, it uploads a full copy. If the remote version is identical, no data is sent.

The plugin settings tab provides vault-wide actions:
- Backup: Uploads full copy of all notes in teh vault to the server.
- Sync: Reconciles the vault to the server. It fetches metadata from the remote, computes and uplaods diffs for modified local notes, and marks remote recorsd as deleted of their local note no longer exist.


## Key Features

- SHA-256 content hashing is used to detect content changes.
- Saves storage by recording changes by lines. Instead of uploading a full file for every modification, the plugin only saves the lines that changed (diffs). Uses the third party library jsdiff - https://github.com/kpdecker/jsdiff.
- Uploads are debounced by 30 secs (configurable from settings).For an active editing session, the plugin keeps track and pushes uploads further out to 30 seconds from each edit. Regulates uploads for repeated keystrokes.
- Aloows user to reconstruct and restore historical versions from the remote.
- Activity History & Live Manager provides a log of the background uploads.
- A remote trash lists the deleted notes available from the remote and allows restore.

## Installation

### 1. Install the Obsidian plugin

**Manual Installation**:

Download the three files `main.js`, `manifest.json` and `styles.css` from the latest release and copy into `.obsidian/plugins/obpb-backup/`.

[Latest release](https://github.com/sukum/OBPB-Backup/releases/latest)

Open "Settings" > "Community plugins" in Obsidian and click the small reload button to the right of the title "Installed plugins".

#### **Connect Obsidian to Pocketbase**
You need to enter the `base url` to the pocketbase instance. And set the `email/password` of a user from Pocketbase. If you haven't configured Pocketbase yet, follw the instrauctions from the below pocketbase sections, and come back with the `email` and `password` of a created user.

Open "Community plugins" > "OBPB Backup".
- Enter the base url for Pocketbase which will be like "http://127.0.0.1:8090/".
- Click "Test connection" to test if pocketbase is accessible through that url.
- Enter "User email" and "Account Password" and click "Test login". If successfull, click "Update password" to save the login information. The login details are stored using [Obsidian's SecretStorage API](https://docs.obsidian.md/plugins/guides/secret-storage).

### 2. Set up PocketBase

Download the source code from https://github.com/sukum/OBPB-Backup/archive/refs/heads/master.zip.
Unzip it, and find the folder named pocketbase in OBPB-Backup-master/pocketbase.
We will use it next to setup the pocketbase database schema.

<ins>**Option A: PocketBase already installed**</ins>

If pocketbase is already installed and configured, you just need to upload the schema and create a user.

To upload the schema
- Open the PocketBase web UI which is avilable at a url like http://127.0.0.1:8090/_/.
- Click "Settings", and on the left menu bar click "Import collections". You will arrive at a url like http://127.0.0.1:8090/_/#/settings/import-collections.
- Click "Load from JSON file", and select `pocketbase/pb_schema.json` from the above downloaded zip file.
- Toggle to on "Merge with the existing collections", and click "Review".
- Click "Confirm and import".
- The schema has been imported.

Create a user from "Collections" > "users". Note the email and password of the created user, as we need to use it in the obsidian plugin settings tab.

Since pocketbase allows a user to be registered via API by default, remember to lock it down. Not needed for the plugin to work though.

- Open the users collection.
- Click the "collection settings" gear button right next to the title.
- Click and open API rules. 
- Click "Set superusers only" for "Create rule". A green lock should appear over it now. If it was already locked, the "Set superusers only" link would be absent.

<ins>**Option B: Standalone binary**</ins>

https://github.com/pocketbase/pocketbase

Download the PocketBase binary for your operating system from pocketbase.io or GitHub releases, unzip it, and place the pocketbase executable into a directory on your PATH.

https://pocketbase.io/docs/going-to-production/

Pocketbase documentation on setting it up. It provides instructions on creating a systemd service, setting up a reverse proxy using nginx/caddy, a Dockerfile to assemble a docker image.

**Follow the below instructions to initialize pocketbase for this plugin.**

Create the initial pocketbase directory structure. Note that the user under whom you intend pocketbase to be run needs to have write permissions for this directory.

```bash
mkdir ./pocketbase
# mkdir /opt/pocketbase # or any dir you prefer 
cd pocketbase
```

Copy pb_migrations from the downloaded OBPB-Backup-master/pocketbase directory to this directory.

```bash
# Assuming you unzipped the latest release to home
cp -Rf ~/OBPB-Backup-master/pocketbase/pb_migrations .
```

Create the directory where pocketbase will store its internal sqlite database files.

```bash
mkdir pb_data
```

Set a pocketbase user to be automatically created by pocketbase on migration.

This user details need to be later added to the obsidian plugin in its settings tab under "Server account", to connect the plugin to this pocketbase instance.

User auth passed as environment variables for the migration script. Change them to your own.
```bash
export POCKETBASE_USER_EMAIL="test@example.com"
# Password should be at least 8 chars long or it will fail
export POCKETBASE_USER_PASSWORD="testpassword"
```

**Create the superuser**

To login to Pocketbase web UI, you will need a superuser. The above normal user cannot login to the web UI. A superuser is not necessarily needed for this plugin's working as long as the migration of the schema and the user creation is successful.

Pocketbase `upsert` sub-command will create a new record or update the password if it is already present.

Remember to change the email and password (atleast 8 chars) before running below command.
```bash
pocketbase superuser upsert "admin@example.com" "AdminPassword" --dir ./pb_data
```

**Starting pocketbase**

Local access (*Pocketbase and Obsidian on the same computer*)
```bash
pocketbase serve --http 127.0.0.1:8090 --migrationsDir ./pb_migrations --dir ./pb_data
```

Pocketbase Web UI: http://127.0.0.1:8090/_/

Obsidian plugin settings url: http://127.0.0.1:8090

Remote access
```bash
pocketbase serve --http 0.0.0.0:8090 --migrationsDir ./pb_migrations --dir ./pb_data
```
Pocketbase Web UI - http://IP-Address:8090/_/

URL to be provided in the obsidian plugin settings - `http://IP-Address:8090`

<ins>**Option B: Docker or Podman**</ins>

Pocketbase does not provide an official image for docker/podman.

There is a third party image available from the github repo [adrianmusante/docker-pocketbase](https://github.com/adrianmusante/docker-pocketbase).
Docker image: https://hub.docker.com/r/adrianmusante/pocketbase

The rest of the instructions are for using this docker image.

**Schema migration**

Copy the folder `pocketbase/pb_migrations` to a local folder. Mount it to docker/podman as `--volume ./pb_migrations:/pocketbase/migrations` for pocketbase to automatically migrate the schema.

User auth passed as environment variables for the migration script. Change them to your own.
```bash
export POCKETBASE_USER_EMAIL="test@example.com"
# Password should be at least 8 chars long or it will fail
export POCKETBASE_USER_PASSWORD="testpassword"
```

Public registration is enabled to the world in pocketbase by default. The migration `002_auth_users_create_locked.js` disables public registration. Otherwise anyone with access to the Pocketbase URL can create a user and read/write to the API.

#### Podman

```bash
podman run -d \
  --name pocketbase \
  -p 8090:8090 \
  --user "$(id -u):$(id -g)" \
  --userns=keep-id \
  --env POCKETBASE_ADMIN_EMAIL=admin@example.com \
  --env POCKETBASE_ADMIN_PASSWORD=password \
  --env POCKETBASE_USER_EMAIL=user@example.com \
  --env POCKETBASE_USER_PASSWORD=yourpassword \
  --volume ./pb_migrations:/pocketbase/migrations:Z \
  --volume ./pb_data:/pocketbase/data:Z \
  docker.io/adrianmusante/pocketbase:0.40
```

#### Docker

```bash
docker run -d \
  --name pocketbase \
  -p 8090:8090 \
  --user "$(id -u):$(id -g)" \
  --env POCKETBASE_ADMIN_EMAIL=admin@example.com \
  --env POCKETBASE_ADMIN_PASSWORD=password \
  --env POCKETBASE_USER_EMAIL=user@example.com \
  --env POCKETBASE_USER_PASSWORD=yourpassword \
  --volume ./pb_migrations:/pocketbase/migrations \
  --volume ./pb_data:/pocketbase/data \
  docker.io/adrianmusante/pocketbase:0.40
```

### 3. Connect Obsidian to PocketBase

Explained above [Connect Obsidian to Pocketbase](#connect-obsidian-to-pocketbase)


## Building from Source

```bash
npm install
npm run build
```

Copies of `manifest.json`, `main.js` and `styles.css` from the root folder should be placed in `your-vault-path/.obsidian/plugins/obpb-backup/`.

## Contact for support

If you face errors during the installation, you can reach out via IRC to me at sree@irc.libera.chat.

[Libera.Chat](https://web.libera.chat/?channel=sree)

## AI Usage

AI (Gemini and ChatGPT) has been used in developing the plugin. The tests have largely been built using AI.

## License
Released under the MIT License.
