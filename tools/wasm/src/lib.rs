// Exact-cover tiling counter (Knuth's Algorithm X with dancing links), a port of `searchTilings`
// in js/logic.js with keep = false. It makes the same choices in the same order, so it visits
// exactly the same search nodes as the JS version (the parity tests compare node counts).
//
// Used only by the generator tools (tools/lib/wasm_counter.mjs); the app and the tests do not
// need it. Build: tools/wasm/build.sh
//
// Interface (all through one shared byte buffer, `io`):
//   io_ptr(n)        make `io` at least n bytes long and return its address
//   register(nbytes) io holds a tile's placements on one board as little-endian u16s:
//                    [len, cell, cell, ...] per placement. Stores them, returns an id.
//   count(id, n, limit, budget)
//                    io[0..n] holds the board (1 = open cell, 0 = blocked). Returns the number
//                    of tilings, stopping at `limit`, or -1 if more than `budget` nodes were needed.
//   nodes()          search nodes used by the last count
use std::cell::RefCell;

#[derive(Default)]
struct Dlx {
    l: Vec<i32>, r: Vec<i32>, u: Vec<i32>, d: Vec<i32>, c: Vec<i32>, s: Vec<i32>,
    item_of: Vec<i32>,
    nodes: u64,
}

// The hot loops use raw pointers (no bounds checks): every index comes from the links built in
// `count`, which are all inside the arrays.
#[derive(Clone, Copy)]
struct Raw { l: *mut i32, r: *mut i32, u: *mut i32, d: *mut i32, c: *mut i32, s: *mut i32 }

struct Search { a: Raw, nodes: u64, count: u32, limit: u32, budget: u64, aborted: bool }

macro_rules! at { ($p:expr, $i:expr) => { *$p.add($i as usize) } }

impl Search {
    unsafe fn cover(&mut self, c: i32) {
        let Raw { l, r, u, d, c: col, s } = self.a;
        at!(l, at!(r, c)) = at!(l, c);
        at!(r, at!(l, c)) = at!(r, c);
        let mut i = at!(d, c);
        while i != c {
            let mut j = at!(r, i);
            while j != i {
                at!(u, at!(d, j)) = at!(u, j);
                at!(d, at!(u, j)) = at!(d, j);
                at!(s, at!(col, j)) -= 1;
                j = at!(r, j);
            }
            i = at!(d, i);
        }
    }

    unsafe fn uncover(&mut self, c: i32) {
        let Raw { l, r, u, d, c: col, s } = self.a;
        let mut i = at!(u, c);
        while i != c {
            let mut j = at!(l, i);
            while j != i {
                at!(s, at!(col, j)) += 1;
                at!(u, at!(d, j)) = j;
                at!(d, at!(u, j)) = j;
                j = at!(l, j);
            }
            i = at!(u, i);
        }
        at!(l, at!(r, c)) = c;
        at!(r, at!(l, c)) = c;
    }

    // true = stop (limit reached or budget blown)
    unsafe fn search(&mut self) -> bool {
        let Raw { l, r, d, c: col, s, .. } = self.a;
        self.nodes += 1;
        if self.nodes > self.budget { self.aborted = true; return true; }
        if at!(r, 0) == 0 {
            self.count += 1;
            return self.count >= self.limit;
        }
        let mut c = at!(r, 0);
        let mut best = at!(s, c);
        let mut j = at!(r, c);
        while j != 0 && best > 1 {
            if at!(s, j) < best { best = at!(s, j); c = j; }
            j = at!(r, j);
        }
        if best == 0 { return false; }
        self.cover(c);
        let mut row = at!(d, c);
        while row != c {
            let mut j = at!(r, row);
            while j != row { self.cover(at!(col, j)); j = at!(r, j); }
            if self.search() { return true; }
            let mut j = at!(l, row);
            while j != row { self.uncover(at!(col, j)); j = at!(l, j); }
            row = at!(d, row);
        }
        self.uncover(c);
        false
    }
}

thread_local! {
    static IO: RefCell<Vec<u8>> = RefCell::new(Vec::new());
    static TILES: RefCell<Vec<Vec<u16>>> = RefCell::new(Vec::new());
    static DLX: RefCell<Dlx> = RefCell::new(Dlx::default());
}

#[no_mangle]
pub extern "C" fn io_ptr(n: usize) -> *mut u8 {
    IO.with(|io| {
        let mut io = io.borrow_mut();
        if io.len() < n { io.resize(n, 0); }
        io.as_mut_ptr()
    })
}

#[no_mangle]
pub extern "C" fn register(nbytes: usize) -> u32 {
    let flat: Vec<u16> = IO.with(|io| io.borrow()[..nbytes].chunks_exact(2).map(|b| u16::from_le_bytes([b[0], b[1]])).collect());
    TILES.with(|t| { let mut t = t.borrow_mut(); t.push(flat); (t.len() - 1) as u32 })
}

#[no_mangle]
pub extern "C" fn count(id: u32, n: usize, limit: u32, budget: f64) -> i32 {
    IO.with(|io| TILES.with(|tiles| DLX.with(|dlx| {
        let io = io.borrow();
        let tiles = tiles.borrow();
        let mut guard = dlx.borrow_mut();
        let d: &mut Dlx = &mut *guard;
        let open = &io[..n];
        let flat = &tiles[id as usize];


        // items 1..m are the open cells
        d.item_of.clear();
        d.item_of.resize(n, -1);
        let mut m = 0i32;
        for i in 0..n { if open[i] != 0 { m += 1; d.item_of[i] = m; } }
        let m_us = m as usize;

        // the placements that lie on open cells only
        let mut kept: Vec<usize> = Vec::new();   // start of each kept placement in `flat`
        let mut total = m_us + 1;
        let mut pos = 0;
        while pos < flat.len() {
            let len = flat[pos] as usize;
            if flat[pos + 1..pos + 1 + len].iter().all(|&c| open[c as usize] != 0) { kept.push(pos); total += len; }
            pos += 1 + len;
        }

        for v in [&mut d.l, &mut d.r, &mut d.u, &mut d.d, &mut d.c] { if v.len() < total { v.resize(total, 0); } }
        d.s.clear(); d.s.resize(m_us + 1, 0);
        for j in 0..=m_us {
            d.l[j] = if j == 0 { m } else { j as i32 - 1 };
            d.r[j] = if j == m_us { 0 } else { j as i32 + 1 };
            d.u[j] = j as i32; d.d[j] = j as i32; d.c[j] = j as i32;
        }
        let mut nn = m_us + 1;
        for &start in &kept {
            let len = flat[start] as usize;
            let first = nn;
            for k in 0..len {
                let col = d.item_of[flat[start + 1 + k] as usize] as usize;
                d.c[nn] = col as i32;
                let ucol = d.u[col];
                d.u[nn] = ucol; d.d[nn] = col as i32;
                d.d[ucol as usize] = nn as i32; d.u[col] = nn as i32;
                d.s[col] += 1;
                if k == 0 { d.l[nn] = nn as i32; d.r[nn] = nn as i32; }
                else { d.l[nn] = nn as i32 - 1; d.r[nn] = first as i32; d.r[nn - 1] = nn as i32; d.l[first] = nn as i32; }
                nn += 1;
            }
        }
        let mut run = Search {
            a: Raw { l: d.l.as_mut_ptr(), r: d.r.as_mut_ptr(), u: d.u.as_mut_ptr(), d: d.d.as_mut_ptr(), c: d.c.as_mut_ptr(), s: d.s.as_mut_ptr() },
            nodes: 0, count: 0, limit, budget: if budget.is_finite() { budget as u64 } else { u64::MAX }, aborted: false,
        };
        unsafe { run.search(); }
        d.nodes = run.nodes;
        if run.aborted { -1 } else { run.count as i32 }
    })))
}

#[no_mangle]
pub extern "C" fn nodes() -> f64 { DLX.with(|d| d.borrow().nodes as f64) }
