module Widget.Counter exposing (view)

import Html exposing (Html, button, div, span, text)
import Html.Attributes exposing (class)
import Html.Events exposing (onClick)
import Types exposing (Model, Msg(..))


{-| Uses the shared Model/Msg; element root with events among its children. -}
view : Model -> Html Msg
view model =
    div [ class "counter" ]
        [ button [ class "dec", onClick Decrement ] [ text "-1" ]
        , span [ class "count" ] [ text (String.fromInt model.count) ]
        , button [ class "inc", onClick Increment ] [ text "+1" ]
        ]
