# Builder feedback notes

- The first unauthenticated `npx @bitrefill/cli@0.3.0` call failed because the machine's default npm cache contained root-owned files (`EPERM`). Setting `npm_config_cache=/private/tmp/oboro-npm-cache` let the real search and details calls run.
- Running the CLI as a child of `pnpm test` inherited npm settings and a `BASE_URL` value that the CLI interpreted as its MCP server URL; this produced an `Invalid URL` error. The shop's CLI adapter now removes those inherited values from the child environment.
- The CLI details response uses `package_value` and `payment_price`; the REST surface uses `value` and package USD price. The parser handles the captured CLI shape separately from the REST envelope.
