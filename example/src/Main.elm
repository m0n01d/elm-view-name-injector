module Main exposing (main)

{-| Composition root for the permutation corpus.

Views are deliberately spread across MANY modules to exercise demangling:

    Main                    - arity + return-shape + attrs/events permutations
    Types                   - shared Model/Msg (no views)
    Ui.Button               - primary / secondary        (msg-agnostic)
    Ui.Layout               - card / page                (higher-order)
    Widget.Badge            - view
    Widget.Counter          - view
    Page.Home               - view / viewToolbar         (cross-module compose)
    Page.Settings.Form      - view / viewField / viewStatus  (3-segment path)

Every view is reachable from `view` below so nothing tree-shakes.
-}

import Browser
import Html exposing (Html, button, div, node, span, text)
import Html.Attributes exposing (class, id, style)
import Html.Events exposing (onClick, onMouseOver)
import Html.Keyed as Keyed
import Html.Lazy as Lazy
import Page.Home as Home
import Page.Settings.Form as SettingsForm
import Types exposing (Model, Msg(..))


init : Model
init =
    { count = 0, name = "demo" }


update : Msg -> Model -> Model
update msg model =
    case msg of
        Increment ->
            { model | count = model.count + 1 }

        Decrement ->
            { model | count = model.count - 1 }

        NoOp ->
            model



-- ARITY (F1/F2/F3 + bare) -----------------------------------------------------


viewA0 : Html Msg
viewA0 =
    div [ class "a0" ] [ text "no args" ]


viewA1 : Model -> Html Msg
viewA1 model =
    div [ class "a1" ] [ text (String.fromInt model.count) ]


viewA2 : Int -> String -> Html Msg
viewA2 count label =
    div [ class "a2" ] [ text (label ++ String.fromInt count) ]


viewA3 : Int -> String -> Bool -> Html Msg
viewA3 count label flag =
    div
        [ class "a3"
        , style "opacity"
            (if flag then
                "1"

             else
                "0.5"
            )
        ]
        [ text (label ++ String.fromInt count) ]



-- RETURN SHAPES ---------------------------------------------------------------


viewElemEmptyAttrs : Html Msg
viewElemEmptyAttrs =
    div [] [ text "empty attrs -> _List_Nil" ]


{-| bare text node -> opaque -> skip (or --wrap). -}
viewText : Html Msg
viewText =
    text "bare text node"


{-| delegation -> returns viewA1(model); callee self-tags. -}
viewDelegate : Model -> Html Msg
viewDelegate model =
    viewA1 model


{-| case -> switch with one return per branch. -}
viewCase : Msg -> Html Msg
viewCase msg =
    case msg of
        Increment ->
            div [ class "inc" ] [ text "inc" ]

        Decrement ->
            button [ onClick NoOp ] [ text "dec" ]

        NoOp ->
            text "noop"


viewPipeElem : Model -> Html Msg
viewPipeElem model =
    [ text (String.fromInt model.count) ]
        |> div [ class "pipe" ]


viewPipeText : Model -> Html Msg
viewPipeText model =
    model.count |> String.fromInt |> text


viewMap : Model -> Html Msg
viewMap model =
    Html.map (always NoOp) (div [ class "mapped" ] [ text "mapped" ])


viewLazy : Model -> Html Msg
viewLazy model =
    Lazy.lazy viewA1 model


stableChild : String -> Html Msg
stableChild s =
    div [ class "stable" ] [ text ("stable: " ++ s) ]


{-| lazy memoized on a field that never changes (name) -> hits after mount. -}
viewLazyStable : Model -> Html Msg
viewLazyStable model =
    Lazy.lazy stableChild model.name


{-| lazy with an inline lambda -> new fn ref every render -> always misses. -}
viewLazyBroken : Model -> Html Msg
viewLazyBroken model =
    Lazy.lazy (\_ -> viewA1 model) ()


viewKeyed : Model -> Html Msg
viewKeyed model =
    Keyed.node "ul"
        [ class "keyed" ]
        [ ( "a", div [] [ text ("item " ++ String.fromInt model.count) ] ) ]


viewCustomNode : Html Msg
viewCustomNode =
    node "custom-element" [ id "custom" ] [ text "custom" ]


{-| REGRESSION: partially-applied `Html.node` -> compiles to
    `var customTag = A2($elm$html$Html$node, "my-element", attrs);` — an arity-3
    fn as A2 whose arg 1 is the TAG string, NOT attrs. Must NOT be spliced;
    doing so made the tag `[object Object]` and crashed rendering in avt-cfg. -}
customTag : List (Html Msg) -> Html Msg
customTag =
    node "my-element" [ class "custom" ]


viewConsAttrs : Bool -> Html Msg
viewConsAttrs flag =
    div
        (class "base"
            :: (if flag then
                    [ class "on" ]

                else
                    []
               )
        )
        [ text "cons attrs" ]


viewChildrenMap : List String -> Html Msg
viewChildrenMap items =
    div [ class "list" ] (List.map (\s -> div [] [ text s ]) items)



-- EXISTING ATTRS / EVENTS -----------------------------------------------------


viewOneAttr : Html Msg
viewOneAttr =
    div [ class "one" ] [ text "1 attr" ]


viewTwoAttrs : Html Msg
viewTwoAttrs =
    div [ class "two", id "two-id" ] [ text "2 attrs" ]


viewAttrPlusEvent : Html Msg
viewAttrPlusEvent =
    button [ class "btn", onClick Increment ] [ text "attr + event" ]


viewEventsOnly : Html Msg
viewEventsOnly =
    button [ onClick Decrement ] [ text "event only" ]


viewManyAttrsEvents : Model -> Html Msg
viewManyAttrsEvents model =
    div
        [ class "many"
        , id "many-id"
        , style "color" "red"
        , onClick Increment
        , onMouseOver NoOp
        ]
        [ text model.name ]


viewAttrsAppended : List (Html.Attribute Msg) -> Html Msg
viewAttrsAppended extra =
    div (baseAttrs ++ extra) [ text "appended attrs" ]


baseAttrs : List (Html.Attribute Msg)
baseAttrs =
    [ class "base", id "base-id" ]



-- NEGATIVES -------------------------------------------------------------------


{-| eta-reduced alias -> `var viewPointFree = viewA1;` -> skip. -}
viewPointFree : Model -> Html Msg
viewPointFree =
    viewA1


{-| REGRESSION: partially-applied Lazy.lazy2 -> `A2(lazy2, fn, ())`. This is a
    FUNCTION (Model -> Html), not Html — like `Icon.element = A2(lazy4, …)` in the
    real app. --wrap must NOT touch it; wrapping made it a div and broke callers
    ("fun is not a function"). -}
lazyPartial : Model -> Html Msg
lazyPartial =
    Lazy.lazy2 (\() m -> viewA1 m) ()


{-| returns List (Html Msg), not a single element -> skip. -}
viewItems : Model -> List (Html Msg)
viewItems model =
    [ span [ class "item" ] [ text "x" ]
    , span [ class "item" ] [ text model.name ]
    ]



-- ROOT — references every local permutation + both pages -----------------------


view : Model -> Html Msg
view model =
    div [ id "root" ]
        [ viewA0
        , viewA1 model
        , viewA2 model.count model.name
        , viewA3 model.count model.name True
        , viewElemEmptyAttrs
        , viewText
        , viewDelegate model
        , viewCase Increment
        , viewPipeElem model
        , viewPipeText model
        , viewMap model
        , viewLazy model
        , viewLazyStable model
        , viewLazyBroken model
        , viewKeyed model
        , viewCustomNode
        , customTag [ text "partial node" ]
        , viewConsAttrs True
        , viewChildrenMap [ "x", "y" ]
        , viewOneAttr
        , viewTwoAttrs
        , viewAttrPlusEvent
        , viewEventsOnly
        , viewManyAttrsEvents model
        , viewAttrsAppended [ class "extra" ]
        , viewPointFree model
        , lazyPartial model
        , div [] (viewItems model)
        , Home.view model
        , SettingsForm.view model
        , button [ onClick Increment ] [ text "+1" ]
        ]


main : Program () Model Msg
main =
    Browser.sandbox { init = init, update = update, view = view }
