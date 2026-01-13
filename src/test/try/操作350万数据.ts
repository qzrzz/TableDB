import { defineTable, SQLiteAdapter } from "tbdb"
 
const __dirname = import.meta.dirname
export const useUserTable = defineTable({
    name: "User",
    adapter: SQLiteAdapter({ filename: __dirname + "/dist/big_350K.sqlite" }),
})

let userTable = await useUserTable()

console.time("findMany")

let docs = await userTable.findMany({
    id: {
        $in: [
            "cvVfmxZ8oFTfMH68R41LQ",
            "cvVfmxZ8oFTfMJPyFU2Ly",
            "cvVfmxZ8oFTfMKPLpSkvv",
            "cvVfmxZ8oFTfMNwh9y5qM",
            "cvVfmxZ8oFTfMPDm7XeGK",
            "cvVfmxZ8oFTfMSPyKSs8E",
            "cvVfmxZnH2PW3jy5Gkq7r",
            "cvVfmxZnH2PW3n1xdnDBu",
            "cvVfmxZnH2PW3nReFDWSD",
            "cvVfmxZnH2PW3pxpXCtjh",
            "cvVfmxZnH2PW3trTx1gKG",
            "cvVfmxZnH2PW3u52N9URk",
            "cvVfmxZnH2PW3wqMLbstF",
            "cvVfmxZnH2PW3yT6Ru1r8",
            "cvVfmxZnH2PW3A9fTTDov",
            "cvVfmxZnH2PW3Dom4zgrx",
            "cvVfmxZnH2PW3DKDg5trh",
            "cvVfmxZnH2PW3GUnQxvyS",
            "cvVfmxZnH2PW3HRC1yKEy",
            "cvVfmxZnH2PW3M8RDQDNQ",
            "cvVfmxZnH2PW3Nd9D9yoW",
            "cvVfmxZnH2PW3QLbkfGKQ",
            "cvVfmxZnH2PW3RNtcuPBq",
            "cvVfmxZnH2PW3Un9v2c9q",
            "cvVfmxZnH2PW3XffDif3b",
            "cvVfmxZnH2PW3XHngG7hX",
            "cvVfmxZnH2PW3ZSsyctmd",
            "cvVfmxZnH2PW43cuYWU9a",
            "cvVfmxZnH2PW45zhrFrRk",
            "cvVfmxZnH2PW46XAHnaLP",
            "cvVfmxZnH2PW49YwnriXN",
            "cvVfmxZnH2PW4bjoqXKqm",
            "cvVfmxZnH2PW4dJMSdFJ8",
            "cvVfmxZnH2PW4fS1yb23f",
            "cvVfmxZnH2PW4gH1TqnQX",
            "cvVfmxZnH2PW4izgQtBSn",
        ],
    },
})
console.timeEnd("findMany")

console.log("Found docs:", docs.length)
