const express = require('express');
const router = express.Router();
const fs = require("fs");
const level = require('level');
const jsonFile = require('jsonfile');
const scheduler = require("node-schedule");
const moment = require("moment");
const axios = require("axios");
const util = require("../modules/util");
const appConfig = jsonFile.readFileSync("./config.json");
const emitter = require('../emitter');
const db = level('.db', {valueEncoding: 'json'});
const {Transactions, Managers, Utils, Identities} = require("@smartholdem/crypto");
const {Connection} = require("@smartholdem/client");

// 0x - users
// 1x - address
// 2x - txInWait
// 3x - txInSuccess
// 4x - txOut

let workerBlock = 0;

Managers.configManager.setFromPreset("mainnet");
Managers.configManager.setHeight(1000000);
const client = new Connection(appConfig.smartholdem.node);

async function init() {
    let result = null;
    if (!fs.existsSync('./cache/blocks.json')) {
        try {
            result = (await axios.get(appConfig.smartholdem.node + '/blockchain')).data.data;
            util.log("BlockchainHeight|" + moment().toISOString() + "|" + result.block.height + "\r\n");
            jsonFile.writeFileSync('./cache/blocks.json', {
                "workerBlock": result.block.height * 1 - appConfig.smartholdem.confirmations * 1
            })
        } catch (e) {
            console.log('err:init: no connect')
        }
    } else {
        workerBlock = jsonFile.readFileSync('./cache/blocks.json').workerBlock;
        util.log("WorkerHeight|" + workerBlock + "|" + moment().toISOString() + "\r\n");
    }

    console.log('GateWay Init on Port:', appConfig.app.port);
    console.log('Start Block', workerBlock);
    console.log('Start Scheduler');
    // 5 блоков каждые 40 сек
    scheduler.scheduleJob("*/7 * * * * *", async () => {
        await shWay.getBlocks()
    });
}

// main class
class SHWAY {

    //ok
    async getNewAddressBySalt(account, provider = 'exchange_name') {
        const PASS = appConfig.smartholdem.salt + account;
        const address = Identities.Address.fromPassphrase(PASS, 63)
        await db.put('0x' + account, {
            "addr": address,
            "provider": provider,
        });
        await db.put('1x' + address, {
            "account": account,
            "created": Math.floor(Date.now() / 1000),
            "provider": provider,
        });
        return ({"addr": address});
    }

    //ok
    async getAddress(account, provider = 'exchange_name') {
        let newAddress = null;
        try {
            let value = await db.get('0x' + account);
            return (value);
        } catch (err) {
            newAddress = await this.getNewAddressBySalt(account, provider);
            await util.log("newaddress|" + newAddress.addr + "|" + account + "\r\n");
            return (newAddress);
        }
    }

    //ok
    async validate(address) {
        return (Identities.Address.validate(address))
    }

    //ok
    async readDb(from, to) {
        return new Promise((resolve, reject) => {
            let list = {};
            db.createReadStream({gte: from + 'x', lt: to + 'x', "limit": 10000})
                .on('data', function (data) {
                    list[data.key] = data.value;
                })
                .on('end', function () {
                    resolve(list);
                });
        });
    }

    //ok
    async searchAddress(recipient) {
        try {
            let value = await db.get('1x' + recipient);
            return ({
                found: true,
                account: value.account
            });
        } catch (err) {
            return ({found: false});
        }
    }

    //ok
    async getTransactions(blockId) {
        let result = []
        try {
            result = (await axios.get(appConfig.smartholdem.node + '/blocks/' + blockId + '/transactions')).data.data;
        } catch (e) {
            console.log('err:getTransactions:blockId - ' + blockId);
        }
        return result
    }

    async getTxs(blockId) {
        let txs = await this.getTransactions(blockId);
        for (let i = 0; i < txs.length; i++) {
            if (txs[i].type === 0 && txs[i].amount >= (appConfig.smartholdem.minDeposit * 10 ** 8)) {
                let dataSearch = await this.searchAddress(txs[i].recipient);
                if (dataSearch.found) {
                    const preparedTx = {
                        asset: 'STH',
                        id: txs[i].id, //tx id
                        recipientId: txs[i].recipient, // address sth recipient
                        comment: txs[i].vendorField || '', //sth memo
                        account: dataSearch.account, //exchange account
                        amount: txs[i].amount / 1e8, // real amount
                        timestamp: Math.floor(Date.now() / 1000),
                    };
                    db.get('3x' + txs[i].id, function (err, value) {
                        if (err) {
                            util.log("newtxin|" + (preparedTx.amount) + "STH|" + preparedTx.account + "|" + preparedTx.recipientId + "|" + moment().toISOString() + "\r\n");
                            db.put('2x' + txs[i].id, preparedTx); // add tx wait
                        }
                    });
                }
            }
        }
    }

    async getBlocks() {
        let response = null;
        try {
            response = (await axios.get(appConfig.smartholdem.node + '/blocks/' + workerBlock)).data.data;
            //console.log(response)
            if (response.transactions > 0) {
                console.log(workerBlock, 'count txs', response.transactions);
                await this.getTxs(response.id);
            }
            workerBlock++
            await jsonFile.writeFile('./cache/blocks.json', {"workerBlock": workerBlock});
        } catch (e) {
            //console.log('err:getBlocks:' + workerBlock);
        }
    }

    //ok
    async sendtoaddress(recipient, amount, comment = null) {
        console.log('sendtoaddress')
        return (await this.sendfrom(appConfig.smartholdem.masterKey, recipient, amount, comment));
    }

    async getAddressInfo(address) {
        let result = null;
        try {
            result = (await axios.get(appConfig.smartholdem.node + '/wallets/' + address)).data.data;
        } catch (e) {
            console.log('err:getAddressInfo', address)
        }
        return result;
    }

    async sendfrom(senderPassphrase, recipient, amount, comment = null) {
        let txs = [];
        let result = null;
        const sender = Identities.Address.fromPassphrase(senderPassphrase, 63);
        const senderWallet = await client.api("wallets").get(sender);
        const senderNonce = Utils.BigNumber.make(senderWallet.body.data.nonce).plus(1);
        const transaction = Transactions.BuilderFactory.transfer()
            .fee('100000000')
            .version(2)
            .nonce(senderNonce.toFixed())
            .recipientId(recipient)
            .amount((amount * 1e8).toFixed(0))
            .vendorField(comment)
            .sign(senderPassphrase);
        txs.push(transaction.build().toJson())
        try {
            const broadcastResponse = await client.api("transactions").create({transactions: txs});
            result = JSON.stringify(broadcastResponse.body.data, null, 4)
            console.log('Result send STH', result)
            if (broadcastResponse.body.data.invalid.length < 1) {
                let txOutData = {
                    tx: txs[0],
                    timestamp: Math.floor(Date.now() / 1000)
                };
                await this.dbput('4x' + txs[0].id, txOutData);
            } else {
                console.log('err send tx, invalid tx')
            }
        } catch (e) {
            console.log('err send tx:', e);
        }
        return result;
    }

    async dbput(key, value) {
        return (await db.put(key, value));
    }

    async reportsTxsOut() {
        return (await this.readDb(4, 5));
    }

}


const shWay = new SHWAY();
init();


scheduler.scheduleJob("*/31 * * * * *", async () => {
    const txsWait = await shWay.readDb(2, 3);
    let keys = Object.keys(txsWait);
    for (let i = 0; i < keys.length; i++) {
        const addressInfo = await shWay.getAddressInfo(txsWait[keys[i]].recipientId);
        console.log('addressInfo', addressInfo.balance / 1e8, addressInfo)
        if (addressInfo.balance / 1e8 >= txsWait[keys[i]].amount) {
            await db.del('2x' + txsWait[keys[i]].id);
            await db.put('3x' + txsWait[keys[i]].id, txsWait[keys[i]]);
            await shWay.sendfrom(
                appConfig.smartholdem.salt + txsWait[keys[i]].account,
                appConfig.smartholdem.masterAddress,
                (addressInfo.balance / 1e8) - 1,
            );
            console.log('send on hot', (addressInfo.balance / 1e8) - 1);
            emitter.eventBus.sendEvent('sth-issue', txsWait[keys[i]]);
        }
    }
});

/* GET home page. */
router.get('/getaddress/:account', function (req, res, next) {
    shWay.getAddress(req.params["account"]).then(function (data) {
        res.json(data);
    });
});

router.get('/validate/:address', function (req, res, next) {
    shWay.validate(req.params["address"]).then(function (data) {
        res.json({"valid": data});
    });
});

router.get('/reports/txout', function (req, res, next) {
    shWay.readDb(4, 5).then(function (data) {
        res.json(data);
    });
});

router.get('/reports/txinwait', function (req, res, next) {
    shWay.readDb(2, 3).then(function (data) {
        res.json(data);
    });
});

router.get('/reports/txinsuccess', function (req, res, next) {
    shWay.readDb(3, 4).then(function (data) {
        res.json(data);
    });
});

router.get('/transactions/block/:id', function (req, res, next) {
    shWay.getTransactions(req.params["id"]).then(function (data) {
        res.json(data);
    });
});

emitter.eventBus.on('sth-transfer', async function (data) {
    console.log('sth-transfer', data);
    await shWay.sendtoaddress(data.recipientId, data.amount, data.vendorField);
});

module.exports = router;
