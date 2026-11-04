use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const MAX_FRAME: usize = 4 * 1024 * 1024;
pub type Headers = Vec<(String, String)>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Request {
    pub v: u8,
    pub id: String,
    pub method: String,
    pub path: String,
    pub headers: Headers,
    pub body_b64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Response {
    pub v: u8,
    pub id: String,
    pub status: u16,
    pub headers: Headers,
    pub body_b64: String,
}

/// Sent by the gate as soon as it accepts a stream. nym-sdk 1.21.4 silently drops Data
/// frames that reach a stream the receiver has not accepted (registered) yet, so the tunnel
/// must not send the request before it has seen this frame.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Ready {
    pub v: u8,
    pub ready: bool,
}

pub fn encoded_body(body: &[u8]) -> String {
    STANDARD.encode(body)
}
pub fn decoded_body(body: &str) -> Result<Vec<u8>> {
    STANDARD.decode(body).context("invalid base64 body")
}

pub fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    let json = serde_json::to_vec(value).context("serialize frame")?;
    if json.len() > MAX_FRAME {
        bail!("frame too large: {} bytes (max {MAX_FRAME})", json.len());
    }
    let mut frame = Vec::with_capacity(4 + json.len());
    frame.extend_from_slice(&(json.len() as u32).to_be_bytes());
    frame.extend_from_slice(&json);
    Ok(frame)
}

pub async fn write<T: Serialize, W: AsyncWrite + Unpin>(
    stream: &mut W,
    value: &T,
) -> Result<usize> {
    let frame = encode(value)?;
    stream.write_all(&frame).await.context("write frame")?;
    stream.flush().await.context("flush frame")?;
    Ok(frame.len())
}

pub async fn read<T: DeserializeOwned, R: AsyncRead + Unpin>(stream: &mut R) -> Result<(T, usize)> {
    let mut prefix = [0u8; 4];
    stream
        .read_exact(&mut prefix)
        .await
        .context("truncated frame length")?;
    let len = u32::from_be_bytes(prefix) as usize;
    if len > MAX_FRAME {
        bail!("frame too large: {len} bytes (max {MAX_FRAME})");
    }
    let mut json = vec![0u8; len];
    stream
        .read_exact(&mut json)
        .await
        .context("truncated frame payload")?;
    let value = serde_json::from_slice(&json).context("invalid frame JSON")?;
    Ok((value, len + 4))
}

pub fn strip_headers(headers: &Headers) -> Headers {
    let connection_tokens: Vec<String> = headers
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case("connection"))
        .flat_map(|(_, v)| {
            v.split(',')
                .map(|s| s.trim().to_ascii_lowercase())
                .collect::<Vec<_>>()
        })
        .collect();
    headers
        .iter()
        .filter(|(name, _)| {
            let k = name.to_ascii_lowercase();
            !matches!(
                k.as_str(),
                "connection"
                    | "keep-alive"
                    | "transfer-encoding"
                    | "te"
                    | "trailer"
                    | "upgrade"
                    | "host"
                    | "proxy-connection"
                    | "forwarded"
                    | "x-forwarded-for"
                    | "x-real-ip"
                    | "cf-connecting-ip"
                    | "true-client-ip"
            ) && !k.starts_with("proxy-")
                && !connection_tokens.contains(&k)
        })
        .cloned()
        .collect()
}

pub fn parse_nym_path(uri: &str) -> Result<(nym_sdk::mixnet::Recipient, String)> {
    let tail = uri
        .strip_prefix("/nym/")
        .context("path must start with /nym/")?;
    let (segment, rest) = tail
        .split_once('/')
        .context("missing path after recipient")?;
    let decoded = percent_encoding::percent_decode_str(segment)
        .decode_utf8()
        .context("bad recipient encoding")?;
    let recipient = decoded.parse().context("bad Nym recipient")?;
    Ok((recipient, format!("/{rest}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn frame_roundtrip() {
        let request = Request {
            v: 1,
            id: "a".into(),
            method: "GET".into(),
            path: "/x".into(),
            headers: vec![],
            body_b64: encoded_body(b"hello"),
        };
        let bytes = encode(&request).unwrap();
        let (decoded, size): (Request, _) = read(&mut bytes.as_slice()).await.unwrap();
        assert_eq!(size, bytes.len());
        assert_eq!(decoded_body(&decoded.body_b64).unwrap(), b"hello");
    }
    #[test]
    fn oversize_rejected() {
        let frame = (MAX_FRAME as u32 + 1).to_be_bytes();
        let error = encode(&"x".repeat(MAX_FRAME)).unwrap_err();
        assert!(error.to_string().contains("frame too large"));
        let rt = tokio::runtime::Runtime::new().unwrap();
        let error = rt
            .block_on(read::<Request, _>(&mut frame.as_slice()))
            .unwrap_err();
        assert!(error.to_string().contains("frame too large"));
    }
    #[tokio::test]
    async fn ready_then_request_on_one_stream() {
        // The gate writes Ready first, then the response; a reader must see them in order.
        let mut bytes = encode(&Ready { v: 1, ready: true }).unwrap();
        let req = Request {
            v: 1,
            id: "r".into(),
            method: "GET".into(),
            path: "/".into(),
            headers: vec![],
            body_b64: String::new(),
        };
        bytes.extend(encode(&req).unwrap());
        let mut slice = bytes.as_slice();
        let (ready, _): (Ready, _) = read(&mut slice).await.unwrap();
        assert!(ready.ready && ready.v == 1);
        let (got, _): (Request, _) = read(&mut slice).await.unwrap();
        assert_eq!(got.id, "r");
        // A request frame is not a valid Ready frame.
        assert!(read::<Ready, _>(&mut encode(&req).unwrap().as_slice()).await.is_err());
    }
    #[tokio::test]
    async fn truncated_frame_rejected() {
        let mut bytes = 10u32.to_be_bytes().to_vec();
        bytes.extend_from_slice(b"abc");
        assert!(read::<Request, _>(&mut bytes.as_slice())
            .await
            .unwrap_err()
            .to_string()
            .contains("truncated"));
    }
    #[test]
    fn strips_hop_headers() {
        let h = vec![
            ("Connection".into(), "x-extra".into()),
            ("X-Extra".into(), "v".into()),
            ("Host".into(), "a".into()),
            ("Proxy-Authorization".into(), "s".into()),
            ("X-Forwarded-For".into(), "127.0.0.1".into()),
            ("Accept".into(), "ok".into()),
        ];
        assert_eq!(strip_headers(&h), vec![("Accept".into(), "ok".into())]);
    }
    #[test]
    fn parses_path_query_and_bad_recipient() {
        let recipient = nym_sdk::mixnet::Recipient::try_from_bytes([
            67, 5, 132, 146, 3, 236, 116, 89, 254, 57, 131, 159, 69, 181, 55, 208, 12, 108, 136,
            83, 58, 76, 171, 195, 31, 98, 92, 64, 68, 53, 156, 184, 100, 189, 73, 3, 238, 103, 156,
            108, 124, 199, 42, 79, 172, 98, 81, 177, 182, 100, 167, 164, 74, 183, 199, 213, 162,
            173, 102, 112, 30, 159, 148, 66, 44, 75, 230, 182, 138, 114, 170, 163, 209, 82, 204,
            100, 118, 91, 57, 150, 212, 147, 151, 135, 148, 16, 213, 223, 182, 164, 242, 37, 40,
            73, 137, 228,
        ])
        .unwrap();
        let (parsed, path) = parse_nym_path(&format!("/nym/{recipient}/v1/x?y=1")).unwrap();
        assert_eq!(parsed, recipient);
        assert_eq!(path, "/v1/x?y=1");
        let encoded = recipient
            .to_string()
            .replace('@', "%40")
            .replace('.', "%2E");
        let (parsed_encoded, path_encoded) =
            parse_nym_path(&format!("/nym/{encoded}/v1/x?y=1")).unwrap();
        assert_eq!(parsed_encoded, recipient);
        assert_eq!(path_encoded, "/v1/x?y=1");
        let (_, root_path) = parse_nym_path(&format!("/nym/{recipient}/")).unwrap();
        assert_eq!(root_path, "/");
        assert!(parse_nym_path("/nym/not-a-recipient/x").is_err());
    }
}
