module Page.Settings.Form exposing (view, viewField, viewStatus)

{-| THREE-segment module path -> $author$project$Page$Settings$Form$view must
    demangle to "Page.Settings.Form.view". Also carries the let / if return
    shapes so those live outside Main too.
-}

import Html exposing (Html, div, span, text)
import Html.Attributes exposing (class)
import Types exposing (Model, Msg(..))


view : Model -> Html Msg
view model =
    div [ class "settings-form" ]
        [ viewField model
        , viewStatus model
        ]


{-| let ... in -> `var`s before the return. -}
viewField : Model -> Html Msg
viewField model =
    let
        label =
            "Name: " ++ model.name
    in
    div [ class "field" ] [ text label ]


{-| if -> ternary; both branches are elements (both tagged). -}
viewStatus : Model -> Html Msg
viewStatus model =
    if model.count > 0 then
        span [ class "ok" ] [ text "positive" ]

    else
        span [ class "warn" ] [ text "non-positive" ]
