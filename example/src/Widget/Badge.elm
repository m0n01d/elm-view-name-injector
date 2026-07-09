module Widget.Badge exposing (view)

import Html exposing (Html, span, text)
import Html.Attributes exposing (class)


{-| A module named after the widget, whose main export is just `view`
    -> demangles to Widget.Badge.view (distinct from every other `view`). -}
view : String -> Html msg
view label =
    span [ class "badge" ] [ text label ]
