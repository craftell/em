# Verify private-network access

DRAFT. This journey has not been run. Unit and CLI tests do not prove access from
another Tailscale machine or browser behavior on an HTTP IP origin.

## Preconditions

Use two machines already connected to the same permitted private network.
Use a disposable model and a fresh browser tab. Obtain the server machine's
actual Tailscale IP from the operator. Do not change network access or firewall
rules as part of this journey.

Build the current source with the repository's normal build command. Confirm
that the built CLI's help lists `--host`. Published emviz 0.4.0 lacks this option.

## Remote viewer

1. Run `node packages/cli/dist/index.js open "$PROJECT" --host "$TAILSCALE_IP"`.
   Retain the returned clean `url`, private `viewerUrl`, token, and PID.
2. On the second machine, request the clean origin's `/api/session` without
   credentials. Expect HTTP 403 with no model or capability in the body.
   Repeat for `/api/model`, `/api/validation`, and `/api/diff`.
3. Open `viewerUrl` privately on the second machine. Expect a populated graph.
   Confirm that the address bar no longer includes the fragment.
4. Reload the same tab. Expect the same model to load with tab-scoped credentials.
   In a fresh private browsing session, open only the clean `url`. Expect no
   project data until the private viewer link is supplied.
5. Select a node and submit **Node feedback**. Verify that feedback works on the
   HTTP IP origin, where `crypto.randomUUID` can be unavailable.
6. Run the CLI poll and reply commands with the clean `url` and token. Edit
   only the disposable model. Verify the reply and **Turn diff** in the browser.
7. Test clipboard controls. If the browser blocks clipboard access for plain
   HTTP, record which controls fail and copy displayed text manually. Some copy controls
   currently have no visible failure message. Report this limitation rather than
   treating a click as proof of copying.
8. Export the model and close the server with its own clean `url` and token.
   Open the standalone export. Verify that it contains no session token and
   works without the server.
9. Confirm that the owned listener no longer answers from either machine.

## Host and Origin rejection

Against the same remote listener, use a request client that can set headers.
Send requests with a hostile Host, the loopback Host, and a wrong port. Expect
HTTP 403 even with the correct capability. Send the correct Host with a foreign
Origin or `Origin: null`. Expect HTTP 403. Do not add wildcard CORS or proxy
exceptions to make the test pass.

Repeat with an assigned concrete IPv6 address when the network supports IPv6.
The printed URL must bracket the address. Record unavailable IPv6 as untested.

## Evidence

Record the commit, commands, HTTP status checks, browser reload result, feedback
reply, and cleanup result. Redact the token and fragment from all shared evidence.
Close the server before sharing traces because traces can contain authorization
headers. Keep this journey marked unexecuted until the actual run succeeds.
