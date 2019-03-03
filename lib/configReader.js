/**
 * Cryptonote Node.JS Pool
 * https://github.com/dvandal/cryptonote-nodejs-pool
 *
 * Configuration Reader
 **/

// Load required modules
var fs = require('fs');

// Set pool software version
global.version = "v4.2";

/**
 * Load pool configuration
 **/
 
// Get configuration file path
var configFile = (function(){
    for (var i = 0; i < process.argv.length; i++){
        if (process.argv[i].indexOf('-config=') === 0)
            return process.argv[i].split('=')[1];
    }
    return 'config.json';
})();

// Read configuration file data
try {
    global.config = JSON.parse(fs.readFileSync(configFile));
}
catch(e){
    console.error('Failed to read config file ' + configFile + '\n\n' + e);
    return;
}

/**
 * Developper donation addresses -- thanks for supporting my works!
 **/
 
var donationAddresses = {
    DERO: 'dERogYfNeNuHm1xJCDB1P8CvdHbtzvvf38D4pKARh6N5RjXrAJTfteCMoLsyzQMY1ceZM5ZAUAUKegsjTvXChhxC8oNdPamc1x',
    PK: 'PkRUiBSt3X9ABbqSqCuRmiPLiwbqFTDXoYRkr12KtBGCNfQaGFuf1vcfN6j5mGcavZbhDgxkDaUhuQ1rotwcUW9u2y8AnHhSS',
    FIMFL: 'FmtuaygYtm3GPXkYpEXEUb9tSw4z2JzarWc2BVVjKDdo27nXrj4CcR3Ji4cqg7qSVpP1ysdYqosA5RdpoehyHUNvNfJ7UK5',
    VGC: 'VEonzHRzFtPBgenDvP2ZFb84NHmPr35J7XHc7YGVaN8RX5nJeV2Yt1tLxz8d5j1MgMfa2QZUtShPUJ8AKz2vht4m76xx9L1Xof',
	EDL: 'edpre1sZPVB9K1QgEYdXrfM9dj8N1XYgcMBjXgUNwK1WGGQSPxGPCHb8ARvMqECuC9LVfy4wUDZJ8WPeF3fJGwc61tyEAaFct',
    FRED: 'fEnrgyRMfLaWkkqVsQ9K5YjnuGS366UgESUnjZecD2KEKhUMNoJcE6fA535BEKCtAeBHX9GNz8oHNfSiKcdiHv3ZZQdKQgKEfmm4F'
};

global.donations = {};

var percent = config.blockUnlocker.devDonation;
var wallet = donationAddresses[config.symbol];
if (percent && wallet) {
    global.donations[wallet] = percent;
}
