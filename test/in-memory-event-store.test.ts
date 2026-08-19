import { InMemoryEventStore } from "../src/persistence/in-memory-event-store.ts";
import { runEventStoreContract } from "./contracts/event-store-contract.ts";

runEventStoreContract("InMemoryEventStore", () => new InMemoryEventStore());
