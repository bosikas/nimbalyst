# Browser host

Nimbalyst Desktop serves opt-in browser workspaces while the host app is running. Connect from another computer through an SSH tunnel to read transcripts, send prompts, interrupt turns, and answer tool permissions in the host's selected theme. Use the left rail to open extension panels, Automations, or a configured workspace file in PDF Viewer. Extension panels use their installed UI bundles, host-stored preferences, and their own backend tools. Supported session and worktree controls and catalog-authorized reads of sessions, worktrees, and tracker items are scoped to the connected workspace. Other desktop APIs may be unavailable in the browser.

Create a private configuration file on the Linux PC. Generate the access token with `openssl rand -hex 32` and set the file mode to `600`.

```json
{
  "workspacePath": "/home/you/projects/example",
  "pdfPath": "docs/example.pdf",
  "token": "<64 lowercase hexadecimal characters>",
  "port": 17864
}
```

Use the workspace path as shown in Nimbalyst. The optional PDF path is relative to the workspace and the file limit is 32 MB. The port defaults to 17864.

To serve more than one workspace from the same desktop app, make the configuration a JSON array of these objects. Set a distinct port and token for each workspace and forward each port through SSH. Open the workspaces in separate desktop windows so their extension backends can run. On the client, open each forwarded address in its own tab or window and use that workspace's token.

Launch a built Nimbalyst desktop app that includes this change with the configuration file path.

```sh
NIMBALYST_BROWSER_HOST_CONFIG="$HOME/.config/nimbalyst-browser-host.json" nimbalyst
```

On your computer, forward the port and open `http://127.0.0.1:17864/` in a browser. Enter the token from the host configuration.

```sh
ssh -N -L 17864:127.0.0.1:17864 you@linux-pc
```

The browser keeps the token in memory until you disconnect or close the page.

## Schedule automations

Keep the configured workspace open in Nimbalyst on Linux with the Automations extension enabled. In the browser, open **Automations** from the left rail to view schedules and create daily, weekly, or interval runs. Daily and weekly times use the Linux host's time zone. The existing extension stores schedules in the workspace and runs them while the host app is open, including when the browser is disconnected.
