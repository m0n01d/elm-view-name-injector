module Types exposing (Model, Msg(..))

{-| Shared Model/Msg so page & widget modules don't create an import cycle with
    Main. (The classic "extract the types" pattern.)
-}


type alias Model =
    { count : Int, name : String }


type Msg
    = Increment
    | Decrement
    | NoOp
