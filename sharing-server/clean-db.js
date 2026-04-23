const { rmSync, existsSync } = require('fs');
const net = require('net');

const port = parseInt(process.env.PORT ?? '3000', 10);

function isServerRunning(port) {
	return new Promise((resolve) => {
		const socket = new net.Socket();
		socket.setTimeout(500);
		socket.on('connect', () => { socket.destroy(); resolve(true); });
		socket.on('error', () => resolve(false));
		socket.on('timeout', () => { socket.destroy(); resolve(false); });
		socket.connect(port, '127.0.0.1');
	});
}

async function main() {
	if (await isServerRunning(port)) {
		console.error(`Error: the sharing server is still running on port ${port}.`);
		console.error('Stop it first, then re-run npm run clean:db.');
		process.exit(1);
	}

	const files = ['./data/sharing.db', './data/sharing.db-shm', './data/sharing.db-wal'];
	files.forEach(f => {
		if (existsSync(f)) {
			try {
				rmSync(f);
				console.log('Removed ' + f);
			} catch (err) {
				if (err.code === 'EPERM' || err.code === 'EBUSY') {
					console.error(`Cannot remove ${f} — the file is locked.`);
					process.exit(1);
				}
				throw err;
			}
		}
	});
	console.log('Done.');
}

main();
