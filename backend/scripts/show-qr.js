const qrcode = require('qrcode-terminal');
const { internalIpV4 } = require('internal-ip');

(async () => {
    const ip = await internalIpV4();
    if (ip) {
        const url = `http://${ip}:5173`;
        console.log('\n\n');
        console.log('📱 \x1b[36mSCAN TO OPEN ON MOBILE:\x1b[0m');
        console.log(`   \x1b[4m${url}\x1b[0m`);
        console.log('\n');
        qrcode.generate(url, { small: true });
        console.log('\n');
    } else {
        console.log('Could not determine local IP address.');
    }
})();
