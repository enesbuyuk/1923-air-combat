//! Small vector / quaternion toolkit plus the deterministic RNG.

#[derive(Clone, Copy, Default)]
pub struct V3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

pub const UP: V3 = V3::new(0.0, 1.0, 0.0);
pub const RIGHT: V3 = V3::new(1.0, 0.0, 0.0);
/// Local nose direction of every aircraft.
pub const FORWARD: V3 = V3::new(0.0, 0.0, -1.0);

impl V3 {
    pub const fn new(x: f32, y: f32, z: f32) -> Self {
        V3 { x, y, z }
    }
    pub fn add(self, o: V3) -> V3 {
        V3::new(self.x + o.x, self.y + o.y, self.z + o.z)
    }
    pub fn sub(self, o: V3) -> V3 {
        V3::new(self.x - o.x, self.y - o.y, self.z - o.z)
    }
    pub fn mul(self, s: f32) -> V3 {
        V3::new(self.x * s, self.y * s, self.z * s)
    }
    pub fn dot(self, o: V3) -> f32 {
        self.x * o.x + self.y * o.y + self.z * o.z
    }
    pub fn cross(self, o: V3) -> V3 {
        V3::new(
            self.y * o.z - self.z * o.y,
            self.z * o.x - self.x * o.z,
            self.x * o.y - self.y * o.x,
        )
    }
    pub fn len(self) -> f32 {
        self.dot(self).sqrt()
    }
    /// Unit vector; degenerate input falls back to `FORWARD`.
    pub fn norm(self) -> V3 {
        let l = self.len();
        if l > 1e-6 {
            self.mul(1.0 / l)
        } else {
            FORWARD
        }
    }
    /// Projection onto the ground plane (y = 0).
    pub fn flat(self) -> V3 {
        V3::new(self.x, 0.0, self.z)
    }
    /// Component-wise product.
    pub fn scale(self, o: V3) -> V3 {
        V3::new(self.x * o.x, self.y * o.y, self.z * o.z)
    }
}

#[derive(Clone, Copy)]
pub struct Q {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub w: f32,
}

impl Q {
    pub const IDENTITY: Q = Q { x: 0.0, y: 0.0, z: 0.0, w: 1.0 };
    pub fn axis_angle(axis: V3, a: f32) -> Q {
        let h = a * 0.5;
        let s = h.sin();
        Q { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: h.cos() }
    }
    pub fn mul(self, b: Q) -> Q {
        let a = self;
        Q {
            x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
            y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
            z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
            w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
        }
    }
    pub fn normalize(self) -> Q {
        let l = (self.x * self.x + self.y * self.y + self.z * self.z + self.w * self.w).sqrt();
        Q { x: self.x / l, y: self.y / l, z: self.z / l, w: self.w / l }
    }
    /// Time derivative of the orientation turning at body rates `w` (rad/s).
    pub fn derivative(self, w: V3) -> Q {
        let d = self.mul(Q { x: w.x, y: w.y, z: w.z, w: 0.0 });
        Q { x: 0.5 * d.x, y: 0.5 * d.y, z: 0.5 * d.z, w: 0.5 * d.w }
    }
    /// `self + d * t`, component-wise (integration; normalize afterwards).
    pub fn add_scaled(self, d: Q, t: f32) -> Q {
        Q { x: self.x + d.x * t, y: self.y + d.y * t, z: self.z + d.z * t, w: self.w + d.w * t }
    }
    /// Inverse rotation (for unit quaternions).
    pub fn conj(self) -> Q {
        Q { x: -self.x, y: -self.y, z: -self.z, w: self.w }
    }
    pub fn rotate(self, v: V3) -> V3 {
        let u = V3::new(self.x, self.y, self.z);
        let t = u.cross(v).mul(2.0);
        v.add(t.mul(self.w)).add(u.cross(t))
    }
    /// Orientation whose local -Z points along `fwd` and local +Y is close to `up`.
    pub fn look(fwd: V3, up: V3) -> Q {
        let z = fwd.mul(-1.0).norm();
        let mut x = up.cross(z);
        if x.len() < 1e-4 {
            x = RIGHT;
        }
        let x = x.norm();
        let y = z.cross(x);
        let (m00, m01, m02) = (x.x, y.x, z.x);
        let (m10, m11, m12) = (x.y, y.y, z.y);
        let (m20, m21, m22) = (x.z, y.z, z.z);
        let tr = m00 + m11 + m22;
        let q = if tr > 0.0 {
            let s = (tr + 1.0).sqrt() * 2.0;
            Q { w: 0.25 * s, x: (m21 - m12) / s, y: (m02 - m20) / s, z: (m10 - m01) / s }
        } else if m00 > m11 && m00 > m22 {
            let s = (1.0 + m00 - m11 - m22).sqrt() * 2.0;
            Q { w: (m21 - m12) / s, x: 0.25 * s, y: (m01 + m10) / s, z: (m02 + m20) / s }
        } else if m11 > m22 {
            let s = (1.0 + m11 - m00 - m22).sqrt() * 2.0;
            Q { w: (m02 - m20) / s, x: (m01 + m10) / s, y: 0.25 * s, z: (m12 + m21) / s }
        } else {
            let s = (1.0 + m22 - m00 - m11).sqrt() * 2.0;
            Q { w: (m10 - m01) / s, x: (m02 + m20) / s, y: (m12 + m21) / s, z: 0.25 * s }
        };
        q.normalize()
    }
    /// Normalized lerp toward `b` by `t` (shortest path).
    pub fn nlerp(self, b: Q, t: f32) -> Q {
        let s = if self.x * b.x + self.y * b.y + self.z * b.z + self.w * b.w < 0.0 { -1.0 } else { 1.0 };
        Q {
            x: self.x + (b.x * s - self.x) * t,
            y: self.y + (b.y * s - self.y) * t,
            z: self.z + (b.z * s - self.z) * t,
            w: self.w + (b.w * s - self.w) * t,
        }
        .normalize()
    }
}

pub fn clamp(v: f32, lo: f32, hi: f32) -> f32 {
    v.max(lo).min(hi)
}

/// Does the segment `a`-`b` pass within `r` of `c`? Compares squares: no square root.
pub fn segment_hits_sphere(a: V3, b: V3, c: V3, r: f32) -> bool {
    segment_distance_sq(a, b, c) <= r * r
}

/// Closest distance from point `c` to the segment `a`-`b`.
pub fn segment_distance(a: V3, b: V3, c: V3) -> f32 {
    segment_distance_sq(a, b, c).sqrt()
}

fn segment_distance_sq(a: V3, b: V3, c: V3) -> f32 {
    let ab = b.sub(a);
    let l2 = ab.dot(ab);
    let t = if l2 > 0.0 { clamp(c.sub(a).dot(ab) / l2, 0.0, 1.0) } else { 0.0 };
    let d = a.add(ab.mul(t)).sub(c);
    d.dot(d)
}

/// Xorshift32: tiny, deterministic and good enough for gameplay randomness.
pub struct Rng(pub u32);

impl Rng {
    /// Uniform in [0, 1].
    pub fn next(&mut self) -> f32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        (x as f32) / (u32::MAX as f32)
    }
    pub fn range(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (hi - lo) * self.next()
    }
}
