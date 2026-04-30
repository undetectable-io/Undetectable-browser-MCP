# undetectable-local-api-mcp-ts

[Model Context Protocol](https://modelcontextprotocol.io/) server (TypeScript) wrapping the [Undetectable Browser](https://undetectable.io/) Local API https://api-docs.undetectable.io/. Lets Claude / any MCP client drive the antidetect browser: create profiles, manage proxies, import/export cookies, start/stop browsers in parallel, attach via CDP.

## Install

### As an MCP server (recommended)

No install step needed — `npx` will fetch and run the package on demand.
Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "undetectable-local-api-ts": {
      "command": "npx",
      "args": ["-y", "undetectable-local-api-mcp-ts"],
      "env": {
        "UNDETECTABLE_BASE_URL": "http://127.0.0.1:25325",
        "UNDETECTABLE_TIMEOUT": "60"
      }
    }
  }
}
```
#### Env

- `UNDETECTABLE_BASE_URL` — default `http://127.0.0.1:25325`
- `UNDETECTABLE_TIMEOUT` — seconds, default `60`

### From source (for contributors)
```bash
git clone https://github.com/undetectable-io/Undetectable-browser-MCP
cd Undetectable-browser-MCP
npm install
npm run build
```

#### Run

```bash
# Production (compiled JS)
node dist/server.js
```



## Tools

24 single-call tools + 7 batch tools + `raw_request`:

**Single:** `status`, `close_software`, `list_profiles`, `get_profile_info`,
`start_profile`, `stop_profile`, `create_profile`, `update_profile`,
`delete_profile`, `check_profile_connection`, `send_profiles_to_cloud`,
`make_profiles_local`, `update_browser_version`, `clear_profile_cache`,
`clear_profile_data`, `import_profiles`, `export_profiles`,
`get_profile_cookies`, `clear_profile_cookies`, `list_proxies`, `add_proxy`,
`delete_proxy`, `update_proxy`, `list_groups`, `list_configs`, `list_folders`,
`list_timezones`.

**Batch (Promise.all fan-out):** `stop_profiles`, `start_profiles`,
`delete_profiles`, `clear_profile_cookies_batch`, `clear_profile_cache_batch`,
`get_profile_info_batch`, `update_profiles_batch`.

**Escape hatch:** `raw_request`.
