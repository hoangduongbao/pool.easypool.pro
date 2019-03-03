var coinType = config.coin ? config.coin.toLowerCase() : "default";

 if (coinType === "dero") {
	require('./pool_dero.js');
 } else {
	require('./pool_default.js');
 }
