//! SRP-6a client, so the server can check the master password (and Secret
//! Key) without ever receiving anything that lets it guess them offline
//! without the Secret Key.
//!
//! Zvault SRP v1, shared with the server in `apps/api/src/auth/srp.ts`:
//!
//! ```text
//! N, g   RFC 5054 3072-bit group, g = 5          H = SHA-256
//! PAD(n) big-endian, left-padded to 384 bytes     I = normalized email, s = KDF salt
//! x  = int(srp_x)                                 (from derive_account_keys)
//! v  = g^x                                        (sent once, at sign-up)
//! k  = H(N | PAD(g))
//! A  = g^a                B = k*v + g^b           (a, b: 256 random bits)
//! u  = H(PAD(A) | PAD(B))                         (abort if 0)
//! S  = (B - k*v)^(a + u*x) = (A * v^u)^b
//! K  = H(PAD(S))
//! M1 = H((H(N) xor H(g)) | H(I) | s | PAD(A) | PAD(B) | K)
//! M2 = H(PAD(A) | M1 | K)
//! ```
//!
//! All arithmetic is mod N. `g` in `H(g)` is the single byte 0x05.

use std::sync::OnceLock;

use num_bigint::BigUint;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

use crate::{Error, Result, SymmetricKey, random};

/// Length in bytes of N and of every padded group element on the wire.
pub const SRP_LEN: usize = 384;
/// Length of `M1`, `M2` and the session key `K`.
pub const SRP_PROOF_LEN: usize = 32;

const N_HEX: &str = "\
FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74\
020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F1437\
4FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED\
EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF05\
98DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB\
9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B\
E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF695581718\
3995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33\
A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7\
ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864\
D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E2\
08E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF";
const G: u32 = 5;

struct Group {
    n: BigUint,
    g: BigUint,
    k: BigUint,
}

fn group() -> &'static Group {
    static GROUP: OnceLock<Group> = OnceLock::new();
    GROUP.get_or_init(|| {
        let n = BigUint::parse_bytes(N_HEX.as_bytes(), 16).expect("N is valid hex");
        let g = BigUint::from(G);
        let k = int(&hash(&[&pad(&n), &pad(&g)]));
        Group { n, g, k }
    })
}

/// The verifier `v = g^x` the server stores in place of a password hash.
pub fn verifier(srp_x: &SymmetricKey) -> Vec<u8> {
    let grp = group();
    pad(&grp.g.modpow(&int(srp_x.as_bytes()), &grp.n))
}

/// A client's half of one SRP login, created from the server's `B`.
pub struct ClientSession {
    public_a: Vec<u8>,
    m1: [u8; SRP_PROOF_LEN],
    m2: [u8; SRP_PROOF_LEN],
    key: Zeroizing<[u8; SRP_PROOF_LEN]>,
}

impl ClientSession {
    /// Starts a login: picks a random `a` and computes `A` and the proof `M1`.
    pub fn new(identity: &str, salt: &[u8], srp_x: &SymmetricKey, public_b: &[u8]) -> Result<Self> {
        let a = Zeroizing::new(random::array::<32>()?);
        Self::with_secret(&int(a.as_ref()), identity, salt, srp_x, public_b)
    }

    fn with_secret(
        a: &BigUint,
        identity: &str,
        salt: &[u8],
        srp_x: &SymmetricKey,
        public_b: &[u8],
    ) -> Result<Self> {
        let grp = group();
        if public_b.len() != SRP_LEN {
            return Err(Error::Srp);
        }
        let b_pub = int(public_b);
        if (&b_pub % &grp.n) == BigUint::ZERO {
            return Err(Error::Srp);
        }

        let a_pub = pad(&grp.g.modpow(a, &grp.n));
        let u = int(&hash(&[&a_pub, public_b]));
        if u == BigUint::ZERO {
            return Err(Error::Srp);
        }

        let x = int(srp_x.as_bytes());
        let kv = (&grp.k * grp.g.modpow(&x, &grp.n)) % &grp.n;
        let base = ((&b_pub % &grp.n) + &grp.n - kv) % &grp.n;
        let s = base.modpow(&(a + u * x), &grp.n);
        let key = Zeroizing::new(hash(&[&pad(&s)]));

        let m1 = proof(identity, salt, &a_pub, public_b, key.as_ref());
        let m2 = hash(&[&a_pub, &m1, key.as_ref()]);
        Ok(Self {
            public_a: a_pub,
            m1,
            m2,
            key,
        })
    }

    /// `A`, sent to the server.
    pub fn public_a(&self) -> &[u8] {
        &self.public_a
    }

    /// `M1`, proves to the server that we know `x`.
    pub fn proof(&self) -> &[u8; SRP_PROOF_LEN] {
        &self.m1
    }

    /// Checks the server's `M2`, which proves it holds our verifier and
    /// is not an impostor replaying our traffic.
    pub fn verify_server(&self, m2: &[u8]) -> Result<()> {
        if bool::from(self.m2.as_slice().ct_eq(m2)) {
            Ok(())
        } else {
            Err(Error::Srp)
        }
    }

    /// The shared session key `K`. Treat as secret.
    pub fn session_key(&self) -> &[u8; SRP_PROOF_LEN] {
        &self.key
    }
}

/// `M1 = H((H(N) xor H(g)) | H(I) | s | PAD(A) | PAD(B) | K)`.
fn proof(identity: &str, salt: &[u8], a_pub: &[u8], b_pub: &[u8], key: &[u8]) -> [u8; 32] {
    let grp = group();
    let mut hng = hash(&[&pad(&grp.n)]);
    let hg = hash(&[&[G as u8]]);
    for (x, y) in hng.iter_mut().zip(hg) {
        *x ^= y;
    }
    let hi = hash(&[identity.as_bytes()]);
    hash(&[&hng, &hi, salt, a_pub, b_pub, key])
}

fn hash(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn int(bytes: &[u8]) -> BigUint {
    BigUint::from_bytes_be(bytes)
}

fn pad(n: &BigUint) -> Vec<u8> {
    let bytes = n.to_bytes_be();
    let mut out = vec![0u8; SRP_LEN.saturating_sub(bytes.len())];
    out.extend_from_slice(&bytes);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal server, the mirror of `apps/api/src/auth/srp.ts`.
    struct Server {
        b: BigUint,
        public_b: Vec<u8>,
        v: BigUint,
    }

    impl Server {
        fn new(b: BigUint, verifier: &[u8]) -> Self {
            let grp = group();
            let v = int(verifier);
            let public_b = pad(&((&grp.k * &v + grp.g.modpow(&b, &grp.n)) % &grp.n));
            Self { b, public_b, v }
        }

        fn key(&self, a_pub: &[u8]) -> [u8; 32] {
            let grp = group();
            let u = int(&hash(&[a_pub, &self.public_b]));
            let s = (int(a_pub) * self.v.modpow(&u, &grp.n)).modpow(&self.b, &grp.n);
            hash(&[&pad(&s)])
        }
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn client_and_server_agree() {
        let x = SymmetricKey::generate().unwrap();
        let server = Server::new(int(&random::array::<32>().unwrap()), &verifier(&x));
        let client =
            ClientSession::new("alice@example.com", &[7; 16], &x, &server.public_b).unwrap();

        let key = server.key(client.public_a());
        assert_eq!(&key, client.session_key());
        let m1 = proof(
            "alice@example.com",
            &[7; 16],
            client.public_a(),
            &server.public_b,
            &key,
        );
        assert_eq!(&m1, client.proof());
        let m2 = hash(&[client.public_a(), &m1, &key]);
        assert!(client.verify_server(&m2).is_ok());
    }

    #[test]
    fn wrong_secret_gives_a_different_proof() {
        let x = SymmetricKey::generate().unwrap();
        let server = Server::new(int(&[9; 32]), &verifier(&x));
        let wrong = SymmetricKey::generate().unwrap();
        let client = ClientSession::new("a", &[7; 16], &wrong, &server.public_b).unwrap();
        assert_ne!(&server.key(client.public_a()), client.session_key());
    }

    #[test]
    fn rejects_malicious_b() {
        let x = SymmetricKey::generate().unwrap();
        let n = pad(&group().n);
        assert_eq!(
            ClientSession::new("a", &[0; 16], &x, &[0; SRP_LEN]).err(),
            Some(Error::Srp)
        );
        assert_eq!(
            ClientSession::new("a", &[0; 16], &x, &n).err(),
            Some(Error::Srp)
        );
        assert_eq!(
            ClientSession::new("a", &[0; 16], &x, &[1; 10]).err(),
            Some(Error::Srp)
        );
    }

    #[test]
    fn rejects_a_forged_server_proof() {
        let x = SymmetricKey::generate().unwrap();
        let server = Server::new(int(&[3; 32]), &verifier(&x));
        let client = ClientSession::new("a", &[0; 16], &x, &server.public_b).unwrap();
        assert_eq!(client.verify_server(&[0; 32]), Err(Error::Srp));
        assert_eq!(client.verify_server(&[]), Err(Error::Srp));
    }

    /// Fixed vector shared with the TypeScript server tests. It was produced
    /// by an independent Python implementation of the spec above.
    #[test]
    fn matches_the_shared_test_vector() {
        #[derive(serde::Deserialize)]
        struct Vector {
            identity: String,
            salt: String,
            x: String,
            a: String,
            b: String,
            v: String,
            #[serde(rename = "A")]
            a_pub: String,
            #[serde(rename = "B")]
            b_pub: String,
            #[serde(rename = "K")]
            key: String,
            #[serde(rename = "M1")]
            m1: String,
            #[serde(rename = "M2")]
            m2: String,
        }
        let t: Vector = serde_json::from_str(include_str!("../tests/srp-v1.json")).unwrap();

        let x = SymmetricKey::from_bytes(unhex(&t.x).try_into().unwrap());
        assert_eq!(hex(&verifier(&x)), t.v);

        let server = Server::new(int(&unhex(&t.b)), &unhex(&t.v));
        assert_eq!(hex(&server.public_b), t.b_pub);

        let client = ClientSession::with_secret(
            &int(&unhex(&t.a)),
            &t.identity,
            &unhex(&t.salt),
            &x,
            &server.public_b,
        )
        .unwrap();
        assert_eq!(hex(client.public_a()), t.a_pub);
        assert_eq!(hex(client.session_key()), t.key);
        assert_eq!(hex(client.proof()), t.m1);
        assert!(client.verify_server(&unhex(&t.m2)).is_ok());
    }
}
