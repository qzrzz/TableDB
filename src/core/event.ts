import { EventHub, eventDefineToEnum } from "fzz"
import { ITableFilter, ITableUpdateOp } from "./types"
import { ITableDoc } from "../adapter/adapter"

export const TableEeventDefifne = {
    CheckFilter: <
        { filter: ITableFilter; options?: { ignoreMarkDelete?: boolean; realDelete?: boolean } & Record<string, any> }
    >{},
    CheckInputDoc: <Partial<ITableDoc> | void>{},
    CheckFindOptions: <{ projection?: any }>{},
    CheckOutputDoc: <Partial<ITableDoc> | void>{},
    CheckUpdateOp: <ITableUpdateOp | void>{},
}

export const TabeEvents = eventDefineToEnum(TableEeventDefifne)
