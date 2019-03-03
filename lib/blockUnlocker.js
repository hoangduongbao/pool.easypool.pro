var coinType = config.coin ? config.coin.toLowerCase() : "default";

 if (coinType === "dero") {
	require('./blockUnlocker_dero.js');
 } else {
	require('./blockUnlocker_default.js');
 }
