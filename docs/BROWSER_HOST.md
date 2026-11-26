# Browser host prototype

Nimbalyst Desktop serves an opt-in browser workspace while the host app is running. Use it to list sessions, read transcripts with periodic refresh, interrupt an active turn, or open a workspace PDF in the PDF Viewer. Connect from another computer through an SSH tunnel to the host.

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

Launch a built Nimbalyst desktop app that includes this change with the configuration file path.

```sh
NIMBALYST_BROWSER_HOST_CONFIG="$HOME/.config/nimbalyst-browser-host.json" nimbalyst
```

On your computer, forward the port and open `http://127.0.0.1:17864/` in a browser. Enter the token from the host configuration.

```sh
ssh -N -L 17864:127.0.0.1:17864 you@linux-pc
```

The browser keeps the token in memory until you disconnect or close the page.
