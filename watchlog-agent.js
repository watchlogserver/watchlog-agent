require('app-module-path').addPath(__dirname);
require('dotenv').config();

const command = process.argv[2];

// CLI commands run without starting the full agent
if (command) {
    const { runDiscovery, loadCache, printDiscoverySummary } = require('./app/discovery/index');
    const { syncConfigs } = require('./app/discovery/autoConfig');
    const integrations = require('./integration.json');
    const logWatchlist = require('./log-watchlist.json');

    switch (command) {
        case 'discover':
            runDiscovery({ syncConfig: true }).then(snapshot => {
                printDiscoverySummary(snapshot);
                process.exit(0);
            }).catch(err => {
                console.error('[discover] Error:', err.message);
                process.exit(1);
            });
            break;

        case 'integrations:list':
            console.log('\nCurrent integrations (integration.json):\n');
            integrations.forEach(i => {
                const status = i.monitor ? 'enabled' : i.state || 'disabled';
                const auto = i.autoDetected ? ' [auto-detected]' : '';
                console.log(`  ${i.service}: ${status}${auto}`);
            });
            console.log('');
            process.exit(0);
            break;

        case 'logs:list':
            console.log('\nCurrent log watchlist (log-watchlist.json):\n');
            (logWatchlist.logs || []).forEach(l => {
                const auto = l.autoDetected ? ' [auto-detected]' : '';
                const state = l.enabled ? 'enabled' : 'disabled';
                console.log(`  [${state}] ${l.path}${auto}`);
            });
            console.log('');
            process.exit(0);
            break;

        case 'processes:list': {
            const { detectProcesses } = require('./app/discovery/detectProcesses');
            detectProcesses().then(result => {
                console.log(`\nTop CPU Processes:\n`);
                result.topCpu.slice(0, 10).forEach(p => {
                    console.log(`  PID ${p.pid} | ${p.cpu}% CPU | ${p.memory}MB | ${p.command || p.name}`);
                });
                console.log(`\nTop Memory Processes:\n`);
                result.topMemory.slice(0, 10).forEach(p => {
                    console.log(`  PID ${p.pid} | ${p.memory}MB | ${p.cpu}% CPU | ${p.command || p.name}`);
                });
                console.log('');
                process.exit(0);
            }).catch(err => {
                console.error(err.message);
                process.exit(1);
            });
            break;
        }

        default:
            console.error(`Unknown command: ${command}`);
            console.log('Available commands:');
            console.log('  node watchlog-agent.js discover');
            console.log('  node watchlog-agent.js integrations:list');
            console.log('  node watchlog-agent.js logs:list');
            console.log('  node watchlog-agent.js processes:list');
            process.exit(1);
    }
} else {
    // Normal agent startup
    const App = require('./app');
    new App();
}
