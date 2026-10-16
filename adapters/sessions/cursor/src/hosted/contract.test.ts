import {describe,it} from "vitest";
import {describeSessionContract,acpSessionContractFixture} from "@barry-rocks/sdk/testing";
import {CURSOR_HOSTED} from "../modes.js";
describeSessionContract("Cursor ACP",()=>acpSessionContractFixture(CURSOR_HOSTED.guarantees),{describe,it});
