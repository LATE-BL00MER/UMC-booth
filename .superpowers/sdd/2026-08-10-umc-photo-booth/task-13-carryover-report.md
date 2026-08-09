# Task 13 carry-over — atomic ambiguous-activation resolution

## Scope

This prerequisite closes the Task 12 P1 recovery race. It changes only the
session store/private boundary, delivery client/coordinator, and their direct
tests. Runtime, metrics, and index files were intentionally not changed.

## RED

Regression coverage was written before the production change. The store test
pauses the active metadata write after `activate()` owns the session lock,
starts resolution concurrently, verifies it cannot settle before activation is
released, then checks the result remains readable active. The coordinator test
models a committed activation whose response is aborted, and requires recovery
to register its retained key without another creation. Private/public server
tests require the new fixed private response and reject the route on the public
listener.

```text
$ npm test -- tests/server/session-store.test.ts tests/server/private-server.test.ts tests/server/public-server.test.ts tests/operator/delivery/delivery-coordinator.test.ts
Test Files  3 failed | 1 passed (4)
Tests  14 failed | 34 passed (48)

Key expected failures:
- TypeError: store.resolveActivationOrDelete is not a function
- private POST /api/sessions/:id/resolve returned 404 instead of 200
- coordinator recovery called the removed getActivated path instead of the
  atomic resolver; the fake exposes no getActivated method
- TypeError: client.resolveActivationOrDelete is not a function
```

## GREEN implementation

- `FileSessionStore.resolveActivationOrDelete(id)` runs under the established
  per-session lock. It waits behind activation, deletion, or sweeping work;
  returns `{ status: "active", publicToken, expiresAt }` only after confirming
  active metadata plus ciphertext, otherwise removes an extant non-active or
  unreadable session and returns `{ status: "deleted" }`.
- The private-only `POST /api/sessions/:id/resolve` route returns that fixed
  schema. The former active-only recovery route is removed, and the public
  server has no resolve route.
- `FetchPrivateApiClient` parses only the active/deleted resolution schema.
- `EncryptedDeliveryCoordinator` keeps retained recovery material until the
  resolver's exact result. Active results construct/register the issued session
  before clearing retained state. Deleted results clear retained state only
  after the server has made the terminal decision. Local expiry clears memory
  before any resolver call; it does not trigger deletion or replacement.
  Transport failures still retain recovery state and do not create another
  ciphertext/key.

## GREEN and verification

```text
$ npm test -- tests/server/session-store.test.ts tests/server/private-server.test.ts tests/server/public-server.test.ts tests/operator/delivery/delivery-coordinator.test.ts
Test Files  4 passed (4)
Tests  48 passed (48)

$ npm run typecheck && npm test -- tests/server tests/operator
tsc --noEmit
Test Files  21 passed (21)
Tests  122 passed (122)

$ npm test && npm run typecheck && git diff --check
Test Files  26 passed (26)
Tests  145 passed (145)
tsc --noEmit
exit 0
```

## Files changed

- `src/server/session-store.ts`
- `src/server/private-server.ts`
- `src/operator/delivery/private-api-client.ts`
- `src/operator/delivery/delivery-coordinator.ts`
- `tests/server/session-store.test.ts`
- `tests/server/private-server.test.ts`
- `tests/server/public-server.test.ts`
- `tests/operator/delivery/delivery-coordinator.test.ts`
- `tests/operator/App.test.tsx` (updated injected client contract)

## Concerns

None outstanding. The existing reset-only `deletePending` API remains for a
known unactivated session; ambiguous post-activation recovery no longer uses
it.
