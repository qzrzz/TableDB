import { Bench } from 'tinybench'
import { SQLiteAdapter } from '../SQLiteAdapter'
import { ITableDBAdapterInstance } from '../../adapter'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync, existsSync, rmSync } from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const BENCH_DIR = resolve(__dirname, './dist') // User changed to dist

if (!existsSync(BENCH_DIR)) mkdirSync(BENCH_DIR, { recursive: true })

const DB_PATH = resolve(BENCH_DIR, 'bench_no_index.sqlite')
const DB_PATH_INDEXED = resolve(BENCH_DIR, 'bench_indexed.sqlite')

// Initial cleanup
try {
    if (existsSync(DB_PATH)) rmSync(DB_PATH)
    if (existsSync(DB_PATH_INDEXED)) rmSync(DB_PATH_INDEXED)
} catch (e) {
    console.error("Cleanup error:", e)
}

const adapterNoIndex = SQLiteAdapter({ filename: DB_PATH })
const adapterIndexed = SQLiteAdapter({ filename: DB_PATH_INDEXED })

let tableNoIndex: ITableDBAdapterInstance
let tableIndexed: ITableDBAdapterInstance

const DATA_SIZE = 5000

function generateDoc(i: number) {
    return {
        id: `doc_${i}`,
        name: `User Name ${i}`,
        age: i % 100, // 0-99
        category: i % 10 === 0 ? 'A' : (i % 10 < 5 ? 'B' : 'C'),
        score: i * 1.5,
        tags: [
            i % 2 === 0 ? 'even' : 'odd',
            i % 3 === 0 ? 'div3' : 'non3',
            `tag_${i % 5}`
        ],
        metadata: {
            active: i % 2 === 0,
            loginCount: i
        },
        history: Array.from({ length: 5 }, (_, j) => ({ date: new Date().toISOString(), action: `act_${j}` }))
    }
}

async function run() {
    console.log("Starting Benchmark Setup...")

    // Pre-populate data
    const docs = []
    for (let i = 0; i < DATA_SIZE; i++) {
        docs.push(generateDoc(i))
    }
    console.log(`Generated ${docs.length} docs`)

    try {
        tableNoIndex = await adapterNoIndex.useAdapterInstance('bench_table')
        tableIndexed = await adapterIndexed.useAdapterInstance('bench_table')

        console.log("Inserting into NoIndex Table...")
        await tableNoIndex.insertMany(docs)
        console.log("Inserting into Indexed Table...")
        await tableIndexed.insertMany(docs)

        console.log("Creating Indexes...")
        await tableIndexed.defineIndexes([
            { key: 'age' },
            { key: 'category' },
            { key: 'score' }
        ])
        console.log("Setup Complete.")
    } catch (e) {
        console.error("Setup Failed:", e)
        throw e
    }

    const bench = new Bench({ time: 500 }) // Run each for 500ms

    // --- Read Performance ---

    bench
        .add('get(id) - PK Lookup', async () => {
            await tableNoIndex.get('doc_100')
        })
        .add('findMany({ age: 50 }) - No Index', async () => {
            await tableNoIndex.findMany({ age: 50 })
        })
        .add('findMany({ age: 50 }) - Indexed', async () => {
            await tableIndexed.findMany({ age: 50 })
        })
        .add('findMany({ age: { $gt: 90 } }) - No Index', async () => {
            await tableNoIndex.findMany({ age: { $gt: 90 } })
        })
        .add('findMany({ age: { $gt: 90 } }) - Indexed', async () => {
            await tableIndexed.findMany({ age: { $gt: 90 } })
        })
        .add('findMany({ $or: [{ age: 20 }, { age: 80 }] }) - No Index', async () => {
            await tableNoIndex.findMany({ $or: [{ age: 20 }, { age: 80 }] })
        })
        .add('findMany({ $or: [{ age: 20 }, { age: 80 }] }) - Indexed', async () => {
            await tableIndexed.findMany({ $or: [{ age: 20 }, { age: 80 }] })
        })
        .add('findMany({ tags: "tag_1" }) - Array Value Check', async () => {
            await tableNoIndex.findMany({ tags: "tag_1" })
        })
        .add('findMany({ "metadata.active": true })', async () => {
            await tableNoIndex.findMany({ "metadata.active": true })
        })

    // --- Write Performance (Updates) ---
    // Note: Benchmarks here might skew if updates change the state significantly, but we are just updating random usage counters.

    bench
        .add('updateOne(id)', async () => {
            await tableNoIndex.updateOne(
                { id: 'doc_0' },
                { $set: { 'metadata.loginCount': Math.random() } }
            )
        })
        .add('updateMany({ category: "B" })', async () => {
            await tableNoIndex.updateMany(
                { category: "B" },
                { $set: { 'metadata.updatedAt': new Date().toISOString() } }
            )
        })

    // --- Traversal ---
    bench
        .add('Traverse All (findMany 100 limit)', async () => {
            await tableNoIndex.findMany({}, { limit: 100, offset: 1000 })
        })
        .add('Traverse All (findMany all)', async () => {
            await tableNoIndex.findMany({})
        })

    // --- Bulk ---
    const bulkOps = Array.from({ length: 50 }, (_, i) => ({
        filter: { id: `doc_${i}` },
        updateOp: { $set: { score: i * 2 } }
    }))

    bench.add('bulkUpdate (50 items)', async () => {
        await tableNoIndex.bulkUpdate(bulkOps)
    })

    console.log("\nRunning Benchmarks...")
    await bench.run()

    console.table(bench.table())

    // Teardown
    if (tableNoIndex) await tableNoIndex.close()
    if (tableIndexed) await tableIndexed.close()
}

run().catch(e => console.error(e))
