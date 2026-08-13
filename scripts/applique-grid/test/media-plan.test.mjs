import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMediaPlan, evaluateReorder, galleryTailProblem, PHASE_ORDER } from '../lib/media-plan.mjs';

const HANDLE = 'huddle-crewneck';
const gid = (n) => `gid://shopify/MediaImage/${n}`;
const hash = (c) => c.repeat(64);

const desiredChart = (page, pages, c) => ({
  page,
  pages,
  filename: `${HANDLE}-applique-pattern-chart-${page}-of-${pages}-${c.repeat(8)}.jpg`,
  alt: `Applique pattern chart ${page} of ${pages}: patterns 1-9, X`,
  specHash: hash(c),
});
const liveChart = (n, page, pages, c) => ({
  id: gid(n),
  filename: `${HANDLE}-applique-pattern-chart-${page}-of-${pages}-${c.repeat(8)}.jpg`,
  alt: `Applique pattern chart ${page} of ${pages}: patterns 1-9, X`,
});
const publishedEntry = (n, page, pages, c) => ({
  page,
  filename: `${HANDLE}-applique-pattern-chart-${page}-of-${pages}-${c.repeat(8)}.jpg`,
  mediaGid: gid(n),
  alt: `Applique pattern chart ${page} of ${pages}: patterns 1-9, X`,
  specHash: hash(c),
});
const photo = (n, name) => ({ id: gid(n), filename: name, alt: `${name} description` });

const plan = (over = {}) => buildMediaPlan({
  desired: [], live: [], published: [], variantAttachedIds: new Set(), handle: HANDLE, ...over,
});

test('phase order contract: creates strictly before deletes, barrier between, reorder last', () => {
  assert.deepEqual(PHASE_ORDER, ['creates', 'barrier', 'deletes', 'reorder']);
});

test('converged state yields an empty plan', () => {
  const p = plan({
    desired: [desiredChart(1, 2, 'a'), desiredChart(2, 2, 'b')],
    live: [photo(1, 'flat-1.jpg'), liveChart(2, 1, 2, 'a'), liveChart(3, 2, 2, 'b')],
    published: [publishedEntry(2, 1, 2, 'a'), publishedEntry(3, 2, 2, 'b')],
  });
  assert.deepEqual(p.creates, []);
  assert.deepEqual(p.deletes, []);
  assert.deepEqual(p.suspects, []);
  assert.equal(p.reorderVerdict, 'not-required');
  assert.equal(p.converged, true);
  assert.equal(p.keeps.length, 2);
});

// The previous version of this case asserted `reorderRequired === false` on the reasoning that
// "appended creates already form the tail". A real first publish disproved it: the dry run said
// `reorder not required`, both creates landed MID-gallery, and the next audit reported STALE. With
// creates pending there is no honest verdict to give before they land.
test('first publish: all creates, and the reorder verdict is undetermined until they land', () => {
  const p = plan({
    desired: [desiredChart(1, 2, 'a'), desiredChart(2, 2, 'b')],
    live: [photo(1, 'flat-1.jpg')],
  });
  assert.equal(p.creates.length, 2);
  assert.deepEqual(p.deletes, []);
  assert.equal(p.reorderVerdict, 'undetermined');
  assert.equal(p.converged, false);
});

test('a spec change replaces: create the new, delete the recorded old', () => {
  const p = plan({
    desired: [desiredChart(1, 1, 'n')],
    live: [liveChart(5, 1, 1, 'o')],
    published: [publishedEntry(5, 1, 1, 'o')],
  });
  assert.equal(p.creates.length, 1);
  assert.equal(p.deletes.length, 1);
  assert.equal(p.deletes[0].id, gid(5));
  assert.match(p.deletes[0].reason, /recorded chart \(page 1\) no longer matches/);
});

test('a deletes-only plan is NOT converged', () => {
  // publish.mjs short-circuits on `converged && !stalePublished.length` with "nothing to write", so
  // dropping the deletes term from converged would leave a superseded chart live indefinitely and
  // print a success line while doing it.
  const p = plan({
    desired: [],
    live: [liveChart(5, 1, 1, 'o')],
    published: [publishedEntry(5, 1, 1, 'o')],
  });
  assert.equal(p.creates.length, 0);
  assert.equal(p.deletes.length, 1);
  assert.equal(p.reorderVerdict, 'not-required');
  assert.equal(p.converged, false, 'pending deletes are work; converged must not ignore them');
});

test('the charts segment is ordered by PAGE, not by keep-then-create', () => {
  // Every other fixture happens to feed keeps and creates already in page order, so the sort had no
  // discriminating input: removing it left the suite green while the gallery showed chart 2 first.
  const p = plan({
    desired: [desiredChart(1, 2, 'n'), desiredChart(2, 2, 'o')],
    live: [photo(7, 'sleeve.jpg'), liveChart(5, 2, 2, 'o')],
    published: [publishedEntry(5, 2, 2, 'o')],
  });
  assert.equal(p.creates.length, 1, 'page 1 is new');
  assert.equal(p.keeps.length, 1, 'page 2 is unchanged');

  assert.deepEqual(p.finalOrder, [
    { kind: 'live', id: gid(7) },
    { kind: 'create', filename: p.creates[0].filename },
    { kind: 'live', id: gid(5) },
  ], 'the created page-1 chart must precede the kept page-2 chart, and the photo keeps its place');
});

test('page-count transition 3 -> 2 deletes page 3 and replaces pages 1-2', () => {
  const p = plan({
    desired: [desiredChart(1, 2, 'd'), desiredChart(2, 2, 'e')],
    live: [liveChart(1, 1, 3, 'a'), liveChart(2, 2, 3, 'b'), liveChart(3, 3, 3, 'c')],
    published: [publishedEntry(1, 1, 3, 'a'), publishedEntry(2, 2, 3, 'b'), publishedEntry(3, 3, 3, 'c')],
  });
  assert.equal(p.creates.length, 2);
  assert.equal(p.deletes.length, 3);
});

test('page-count transition 2 -> 3 creates the new page(s)', () => {
  const p = plan({
    desired: [desiredChart(1, 3, 'a'), desiredChart(2, 3, 'b'), desiredChart(3, 3, 'c')],
    live: [liveChart(1, 1, 2, 'x'), liveChart(2, 2, 2, 'y')],
    published: [publishedEntry(1, 1, 2, 'x'), publishedEntry(2, 2, 2, 'y')],
  });
  assert.equal(p.creates.length, 3);
  assert.deepEqual(p.creates.map((c) => c.page), [1, 2, 3]);
  assert.equal(p.deletes.length, 2);
});

test('unrecorded media matching BOTH conventions is adopted via filename + alt equality', () => {
  const d = desiredChart(1, 1, 'a');
  const p = plan({
    desired: [d],
    live: [{ id: gid(9), filename: d.filename, alt: d.alt }],
    published: [],
  });
  assert.deepEqual(p.creates, []);
  assert.equal(p.keeps[0].id, gid(9));
});

test('CDN collision suffix still matches the desired filename', () => {
  const d = desiredChart(1, 1, 'a');
  const p = plan({
    desired: [d],
    live: [{ id: gid(9), filename: d.filename.replace('.jpg', '_x1y2.jpg'), alt: d.alt }],
  });
  assert.deepEqual(p.creates, []);
  assert.equal(p.keeps.length, 1);
});

test('an alt-only difference on an unrecorded chart is a replace, not a keep', () => {
  const d = desiredChart(1, 1, 'a');
  const p = plan({
    desired: [d],
    live: [{ id: gid(9), filename: d.filename, alt: 'Applique pattern chart 1 of 1: patterns 1-9, OLD' }],
  });
  assert.equal(p.creates.length, 1);
  assert.equal(p.deletes.length, 1);
});

test('one-signal matches are suspects with reasons, never touched', () => {
  const p = plan({
    desired: [desiredChart(1, 1, 'a')],
    live: [
      { id: gid(7), filename: `${HANDLE}-applique-pattern-chart-9-of-9-aaaaaaaa.jpg`, alt: 'A lovely photo' },
      { id: gid(8), filename: 'random-shot.jpg', alt: 'Applique pattern chart 3 of 3: patterns 1-2, X' },
    ],
  });
  assert.equal(p.deletes.length, 0);
  assert.equal(p.suspects.length, 2);
  assert.match(p.suspects[0].reasons[0], /filename matches the chart convention but the alt does not/);
  assert.match(p.suspects[1].reasons[0], /alt matches the chart convention but the filename does not/);
  for (const s of p.suspects) assert.ok(s.reasons.every((r) => typeof r === 'string' && r.length));
});

test('variant-attached media is refused for deletion regardless of signals', () => {
  const p = plan({
    desired: [desiredChart(1, 1, 'n')],
    live: [liveChart(5, 1, 1, 'o')],
    published: [publishedEntry(5, 1, 1, 'o')],
    variantAttachedIds: new Set([gid(5)]),
  });
  assert.deepEqual(p.deletes, []);
  assert.equal(p.suspects.length, 1);
  assert.match(p.suspects[0].reasons[0], /attached to a variant; deletion refused/);
});

test('non-chart media keeps its relative order; charts form the tail in page order', () => {
  const d1 = desiredChart(1, 2, 'a');
  const d2 = desiredChart(2, 2, 'b');
  const p = plan({
    desired: [d1, d2],
    live: [
      photo(1, 'flat-1.jpg'),
      liveChart(2, 2, 2, 'b'), // page 2 chart currently sits mid-gallery, before page 1's
      photo(3, 'styled-1.jpg'),
      liveChart(4, 1, 2, 'a'),
    ],
    published: [publishedEntry(4, 1, 2, 'a'), publishedEntry(2, 2, 2, 'b')],
  });
  assert.equal(p.creates.length, 0);
  assert.equal(p.reorderVerdict, 'required');
  assert.deepEqual(p.finalOrder, [
    { kind: 'live', id: gid(1) },
    { kind: 'live', id: gid(3) },
    { kind: 'live', id: gid(4) }, // page 1
    { kind: 'live', id: gid(2) }, // page 2
  ]);
});

test('suspects keep their gallery positions in the final order', () => {
  const d = desiredChart(1, 1, 'a');
  const suspect = { id: gid(7), filename: `${HANDLE}-applique-pattern-chart-9-of-9-ffffffff.jpg`, alt: 'not a chart alt' };
  const p = plan({
    desired: [d],
    live: [photo(1, 'flat-1.jpg'), suspect, photo(3, 'styled-1.jpg')],
  });
  assert.deepEqual(p.finalOrder, [
    { kind: 'live', id: gid(1) },
    { kind: 'live', id: gid(7) },
    { kind: 'live', id: gid(3) },
    { kind: 'create', filename: d.filename },
  ]);
});

test('stale published records (media gone from live) are surfaced for pruning', () => {
  const p = plan({
    desired: [],
    live: [photo(1, 'flat-1.jpg')],
    published: [publishedEntry(99, 1, 1, 'z')],
  });
  assert.equal(p.stalePublished.length, 1);
  assert.equal(p.stalePublished[0].mediaGid, gid(99));
});

// ---------------------------------------------------------------------------
// gallery.pin_after_charts. Every row of the contract table, plus the back-compat lock.
// ---------------------------------------------------------------------------

const LOGO = gid(1001);

test('BACK-COMPAT LOCK: with no pin list, finalOrder is byte-identical to the charts-as-tail rule', () => {
  // The single test most likely to be skipped and most likely to matter. Each ordering fixture is
  // replayed with pinned absent, pinned undefined, and pinned [], and all three must agree.
  const fixtures = [
    {
      desired: [desiredChart(1, 2, 'a'), desiredChart(2, 2, 'b')],
      live: [photo(1, 'flat-1.jpg'), liveChart(2, 2, 2, 'b'), photo(3, 'styled-1.jpg'), liveChart(4, 1, 2, 'a')],
      published: [publishedEntry(4, 1, 2, 'a'), publishedEntry(2, 2, 2, 'b')],
    },
    {
      desired: [desiredChart(1, 1, 'a')],
      live: [photo(1, 'flat-1.jpg'), photo(3, 'styled-1.jpg')],
      published: [],
    },
    {
      desired: [desiredChart(1, 1, 'n')],
      live: [liveChart(5, 1, 1, 'o'), photo(6, 'flat-2.jpg')],
      published: [publishedEntry(5, 1, 1, 'o')],
    },
    { desired: [], live: [photo(1, 'flat-1.jpg')], published: [publishedEntry(99, 1, 1, 'z')] },
  ];
  for (const [i, f] of fixtures.entries()) {
    const bare = JSON.stringify(plan(f).finalOrder);
    assert.equal(JSON.stringify(plan({ ...f, pinned: undefined }).finalOrder), bare, `fixture ${i}: undefined`);
    assert.equal(JSON.stringify(plan({ ...f, pinned: [] }).finalOrder), bare, `fixture ${i}: empty list`);
  }
});

test('an empty pin list and an absent one produce byte-identical plans', () => {
  const f = {
    desired: [desiredChart(1, 1, 'a')],
    live: [photo(1, 'flat-1.jpg'), liveChart(2, 1, 1, 'a')],
    published: [publishedEntry(2, 1, 1, 'a')],
  };
  assert.equal(JSON.stringify(plan(f)), JSON.stringify(plan({ ...f, pinned: [] })));
});

test('pinned media sits AFTER the charts, in declared order', () => {
  const p = plan({
    desired: [desiredChart(1, 2, 'a'), desiredChart(2, 2, 'b')],
    live: [photo(1, 'flat-1.jpg'), liveChart(2, 1, 2, 'a'), liveChart(3, 2, 2, 'b'), { ...photo(0, 'logo.jpg'), id: LOGO }],
    published: [publishedEntry(2, 1, 2, 'a'), publishedEntry(3, 2, 2, 'b')],
    pinned: [LOGO],
  });
  assert.deepEqual(p.finalOrder, [
    { kind: 'live', id: gid(1) },
    { kind: 'live', id: gid(2) },
    { kind: 'live', id: gid(3) },
    { kind: 'live', id: LOGO },
  ]);
  assert.equal(p.reorderVerdict, 'not-required', 'the live gallery already satisfies the rule');
  assert.equal(p.converged, true);
  assert.deepEqual(p.pinned, [LOGO]);
});

test('a pinned media sitting before the charts is a reorder, not a silent revert', () => {
  const p = plan({
    desired: [desiredChart(1, 1, 'a')],
    live: [{ ...photo(0, 'logo.jpg'), id: LOGO }, photo(1, 'flat-1.jpg'), liveChart(2, 1, 1, 'a')],
    published: [publishedEntry(2, 1, 1, 'a')],
    pinned: [LOGO],
  });
  assert.equal(p.reorderVerdict, 'required');
  assert.deepEqual(p.finalOrder, [
    { kind: 'live', id: gid(1) },
    { kind: 'live', id: gid(2) },
    { kind: 'live', id: LOGO },
  ]);
});

test('a pinned GID absent from live media is a HARD FAIL, before any phase runs', () => {
  assert.throws(() => plan({
    desired: [desiredChart(1, 1, 'a')],
    live: [photo(1, 'flat-1.jpg')],
    pinned: [LOGO],
  }), new RegExp(`${LOGO}.*not in the live gallery`));
});

test('a pinned GID that is also a chart is refused at plan time, not only at validation', () => {
  // The registry can be hand-edited between validation and the plan, so this is re-checked here.
  assert.throws(() => plan({
    desired: [desiredChart(1, 1, 'a')],
    live: [liveChart(7, 1, 1, 'a')],
    published: [publishedEntry(7, 1, 1, 'a')],
    pinned: [gid(7)],
  }), /identifies as a chart/);
});

test('a pinned GID this run would delete is refused', () => {
  assert.throws(() => plan({
    desired: [desiredChart(1, 1, 'n')],
    live: [liveChart(5, 1, 1, 'o')],
    published: [publishedEntry(5, 1, 1, 'o')],
    pinned: [gid(5)],
  }), /identifies as a chart|would delete/);
});

test('duplicate and malformed pinned GIDs are refused, naming the offender', () => {
  const live = [{ ...photo(0, 'logo.jpg'), id: LOGO }];
  assert.throws(() => plan({ live, pinned: [LOGO, LOGO] }), new RegExp(`duplicate GID\\(s\\): ${LOGO}`));
  assert.throws(() => plan({ live, pinned: ['1001'] }), /"1001" is not a MediaImage GID/);
});

test('a pin list with zero charts does not manufacture a reorder', () => {
  const p = plan({
    desired: [],
    live: [{ ...photo(0, 'logo.jpg'), id: LOGO }, photo(1, 'flat-1.jpg')],
    published: [],
    pinned: [LOGO],
  });
  assert.deepEqual(p.finalOrder, [{ kind: 'live', id: LOGO }, { kind: 'live', id: gid(1) }]);
  assert.equal(p.reorderVerdict, 'not-required');
  assert.equal(p.converged, true);
});

// ---------------------------------------------------------------------------
// evaluateReorder: the post-barrier judgement publish.mjs makes against ACTUAL state.
// ---------------------------------------------------------------------------

test('evaluateReorder: creates that landed at the end need no move (the old assumption, when true)', () => {
  const r = evaluateReorder([gid(1), gid(2), gid(3)], [gid(1), gid(2), gid(3)]);
  assert.equal(r.required, false);
  assert.deepEqual(r.moves, []);
});

test('evaluateReorder: creates that landed MID-gallery need a move (the observed behaviour)', () => {
  const r = evaluateReorder([gid(1), gid(9), gid(2)], [gid(1), gid(2), gid(9)]);
  assert.equal(r.required, true);
  assert.deepEqual(r.moves, [{ id: gid(2), from: 2, to: 1 }, { id: gid(9), from: 1, to: 2 }]);
});

test('evaluateReorder: creates at index 0, and interleaved', () => {
  assert.equal(evaluateReorder([gid(9), gid(1), gid(2)], [gid(1), gid(2), gid(9)]).required, true);
  assert.equal(evaluateReorder([gid(1), gid(8), gid(2), gid(9)], [gid(1), gid(2), gid(8), gid(9)]).required, true);
});

test('evaluateReorder: a desired id missing from live state is a move from -1, never silent', () => {
  const r = evaluateReorder([gid(1)], [gid(1), gid(2)]);
  assert.equal(r.required, true);
  assert.deepEqual(r.moves, [{ id: gid(2), from: -1, to: 1 }]);
});

test('evaluateReorder: length mismatch alone is enough to require a reorder', () => {
  assert.equal(evaluateReorder([gid(1), gid(2)], [gid(1)]).required, true);
});

test('idempotence: feeding an executed order back yields converged', () => {
  const executed = [
    photo(1, 'flat-1.jpg'), liveChart(2, 1, 2, 'a'), liveChart(3, 2, 2, 'b'), { ...photo(0, 'l.jpg'), id: LOGO },
  ];
  const p = plan({
    desired: [desiredChart(1, 2, 'a'), desiredChart(2, 2, 'b')],
    live: executed,
    published: [publishedEntry(2, 1, 2, 'a'), publishedEntry(3, 2, 2, 'b')],
    pinned: [LOGO],
  });
  assert.equal(p.converged, true);
  assert.equal(evaluateReorder(executed.map((m) => m.id), p.finalOrder.map((e) => e.id)).required, false);
});

// ---------------------------------------------------------------------------
// Property: over random live orders and pin subsets, the ordering invariants hold.
// ---------------------------------------------------------------------------

test('property: every live GID appears once, untouched order preserved, charts contiguous, pins last', () => {
  // Seeded, so a failure is reproducible; Math.random would not be.
  let seed = 20260813 >>> 0;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pinChoices = [[], [LOGO], [LOGO, gid(2)]];

  for (let iter = 0; iter < 200; iter++) {
    const chartIds = [gid(101), gid(102)];
    const live = [
      liveChart(101, 1, 2, 'a'), liveChart(102, 2, 2, 'b'),
      photo(1, 'flat-1.jpg'), photo(2, 'styled-1.jpg'), { ...photo(0, 'logo.jpg'), id: LOGO },
    ];
    for (let i = live.length - 1; i > 0; i--) { // Fisher-Yates on the seeded stream
      const j = Math.floor(rnd() * (i + 1));
      [live[i], live[j]] = [live[j], live[i]];
    }
    const pinned = pinChoices[Math.floor(rnd() * pinChoices.length)];
    const p = plan({
      desired: [desiredChart(1, 2, 'a'), desiredChart(2, 2, 'b')],
      live,
      published: [publishedEntry(101, 1, 2, 'a'), publishedEntry(102, 2, 2, 'b')],
      pinned,
    });

    const ids = p.finalOrder.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, `iter ${iter}: no duplicates`);
    assert.deepEqual([...ids].sort(), live.map((m) => m.id).sort(), `iter ${iter}: same set as live`);

    const first = ids.indexOf(chartIds[0]);
    assert.deepEqual(ids.slice(first, first + 2), chartIds, `iter ${iter}: charts contiguous in page order`);
    assert.deepEqual(ids.slice(ids.length - pinned.length), pinned, `iter ${iter}: pinned media occupies the exact tail`);

    const untouched = live.map((m) => m.id).filter((id) => !chartIds.includes(id) && !pinned.includes(id));
    assert.deepEqual(ids.filter((id) => untouched.includes(id)), untouched, `iter ${iter}: untouched relative order preserved`);
  }
});

// ---------------------------------------------------------------------------
// The audit's tail check, which is the operator's only on-disk record of gallery convergence.
// ---------------------------------------------------------------------------

test('galleryTailProblem: satisfied, violated, pinned missing, no charts', () => {
  const charts = [gid(101), gid(102)];
  assert.equal(galleryTailProblem({
    liveIds: [gid(1), ...charts, LOGO], publishedGids: charts, pinnedGids: [LOGO],
  }), null);
  assert.equal(galleryTailProblem({ liveIds: [gid(1), ...charts], publishedGids: charts, pinnedGids: [] }), null);

  assert.match(galleryTailProblem({
    liveIds: [gid(1), ...charts, LOGO], publishedGids: charts, pinnedGids: [],
  }), /not the contiguous tail/);
  assert.match(galleryTailProblem({
    liveIds: [LOGO, gid(1), ...charts], publishedGids: charts, pinnedGids: [LOGO],
  }), /not followed by the pinned media/);
  assert.match(galleryTailProblem({
    liveIds: [gid(1), ...charts], publishedGids: charts, pinnedGids: [LOGO],
  }), new RegExp(`${LOGO}.*not in the live gallery`));

  // Nothing published: gallery order is not this module's claim to make.
  assert.equal(galleryTailProblem({ liveIds: [gid(1), LOGO], publishedGids: [], pinnedGids: [LOGO] }), null);
});
