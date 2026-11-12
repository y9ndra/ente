import type { Collection } from "ente-media/collection";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const cache = vi.hoisted(() => ({ collections: [] as Collection[] }));

vi.mock("ente-base/origins", () => ({
    apiURL: (path: string) => Promise.resolve(`https://example.test${path}`),
}));
vi.mock("ente-base/http", () => ({
    authenticatedRequestHeaders: () => Promise.resolve({}),
    ensureOk: (response: Response) => {
        if (!response.ok) throw new Error("Request failed");
    },
}));
vi.mock("ente-new/photos/services/photos-fdb", () => ({
    savedCollections: () => Promise.resolve(cache.collections),
    savedCollectionsUpdationTime: () => Promise.resolve(1),
    saveCollections: (collections: Collection[]) => {
        cache.collections = collections;
        return Promise.resolve();
    },
    saveCollectionsUpdationTime: () => Promise.resolve(),
}));

import {
    bindCollectionKeyOpener,
    pullCollections,
    refreshCollection,
} from "ente-new/photos/services/collection";

const album = (id: number, email: string, updationTime = 1): Collection => ({
    id,
    name: "Album",
    type: "album",
    owner: { id: 1 },
    key: "key",
    sharees: [{ id: 2, email, role: "VIEWER" }],
    publicURLs: [],
    updationTime,
});

const remote = (id: number, email: string, updationTime = 1) => ({
    ...album(id, email, updationTime),
    encryptedKey: "encrypted-key",
});

beforeEach(() => {
    cache.collections = [
        album(1, "old@example.com"),
        album(2, "other@example.com"),
    ];
    bindCollectionKeyOpener(() => Promise.resolve("key"));
});

afterEach(() => vi.unstubAllGlobals());

test("refreshes the cached participant email", async () => {
    vi.stubGlobal(
        "fetch",
        vi.fn(() =>
            Promise.resolve(
                Response.json({ collection: remote(1, "new@example.com") }),
            ),
        ),
    );
    await refreshCollection(1);
    expect(cache.collections[0]?.sharees[0]?.email).toBe("new@example.com");
});

test("keeps a newer cached collection", async () => {
    cache.collections[0] = album(1, "newer@example.com", 2);
    vi.stubGlobal(
        "fetch",
        vi.fn(() =>
            Promise.resolve(
                Response.json({
                    collection: remote(1, "older@example.com", 1),
                }),
            ),
        ),
    );
    await refreshCollection(1);
    expect(cache.collections[0].sharees[0]?.email).toBe("newer@example.com");
});

test("allows a retry after a failed refresh", async () => {
    vi.stubGlobal(
        "fetch",
        vi
            .fn()
            .mockResolvedValueOnce(new Response(null, { status: 500 }))
            .mockResolvedValueOnce(
                Response.json({ collection: remote(1, "new@example.com") }),
            ),
    );
    await expect(refreshCollection(1)).rejects.toThrow("Request failed");
    await refreshCollection(1);
    expect(cache.collections[0]?.sharees[0]?.email).toBe("new@example.com");
});

test("keeps other collection updates when sync and refresh overlap", async () => {
    const pending = Promise.withResolvers<Response>();
    vi.stubGlobal(
        "fetch",
        vi.fn((url: string) =>
            url.endsWith("/collections/v2")
                ? pending.promise
                : Promise.resolve(
                      Response.json({
                          collection: remote(1, "new@example.com"),
                      }),
                  ),
        ),
    );
    const sync = pullCollections();
    const refresh = refreshCollection(1);
    pending.resolve(
        Response.json({ collections: [remote(2, "changed@example.com", 2)] }),
    );
    await Promise.all([sync, refresh]);
    expect(
        cache.collections.map((collection) => collection.sharees[0]?.email),
    ).toEqual(["new@example.com", "changed@example.com"]);
});
