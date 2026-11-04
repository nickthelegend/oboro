use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use std::{net::SocketAddr, path::PathBuf, time::Duration};

#[derive(Parser)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    Gate {
        #[arg(long)]
        upstream: String,
        #[arg(long)]
        data: PathBuf,
        #[arg(long, default_value = "127.0.0.1:7411")]
        status: SocketAddr,
        #[arg(long)]
        nym_env: Option<PathBuf>,
    },
    Tunnel {
        #[arg(long, default_value = "127.0.0.1:7410")]
        listen: SocketAddr,
        #[arg(long)]
        data: PathBuf,
        #[arg(long)]
        nym_env: Option<PathBuf>,
        #[arg(long, default_value_t = 180)]
        timeout_secs: u64,
    },
    Probe {
        #[arg(long)]
        to: String,
        #[arg(long)]
        data: Option<PathBuf>,
    },
}
#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Gate {
            upstream,
            data,
            status,
            nym_env,
        } => oboro_node::run_gate(upstream, data, status, nym_env).await,
        Command::Tunnel {
            listen,
            data,
            nym_env,
            timeout_secs,
        } => oboro_node::run_tunnel(data, listen, nym_env, Duration::from_secs(timeout_secs)).await,
        Command::Probe { to, data } => {
            let recipient = to.parse().context("invalid Nym recipient")?;
            let (status, ms) = oboro_node::probe(recipient, data).await?;
            println!(
                "{}",
                serde_json::json!({"ok":status == 200,"status":status,"ms":ms})
            );
            Ok(())
        }
    }
}
