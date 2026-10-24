/*
 * EquipmentCatalog.gs — Studio Xの有料レンタル機材・無料セルフ機材の料金/数量/在庫（Issue #423）。
 *
 * ★自動生成ファイル。直接編集しない。正本は _data/studio_x_equipment.json。
 *   編集後は `node scripts/sync-studio-x-equipment.js` で再生成する（機材ページ
 *   studio-x/equipment/ は同じJSONを直接読むため、料金が食い違わない）。
 */
'use strict';

var StudioXEquipmentCatalog = {
  "rental": [
    {
      "code": "COB_BICOLOR",
      "label": "バイカラーCOBライト（定常光）",
      "stock": 1,
      "unitPriceJpy": 800,
      "unitLabel": "",
      "requiresLecture": true
    },
    {
      "code": "PANEL_FULLCOLOR",
      "label": "フルカラーパネルライト（定常光）",
      "stock": 1,
      "unitPriceJpy": 500,
      "unitLabel": "",
      "requiresLecture": true
    },
    {
      "code": "COB_FULLCOLOR",
      "label": "フルカラーCOBライト（定常光）",
      "stock": 2,
      "unitPriceJpy": 800,
      "unitLabel": "台",
      "requiresLecture": true
    },
    {
      "code": "STROBE_MONOBLOCK",
      "label": "モノブロックストロボ",
      "stock": 1,
      "unitPriceJpy": 800,
      "unitLabel": "",
      "requiresLecture": false
    },
    {
      "code": "STROBE_PORTABLE",
      "label": "ポータブルストロボ",
      "stock": 1,
      "unitPriceJpy": 800,
      "unitLabel": "",
      "requiresLecture": false
    },
    {
      "code": "COMMANDER_CANON",
      "label": "ワイヤレスコマンダー（Canon専用）",
      "stock": 1,
      "unitPriceJpy": 300,
      "unitLabel": "",
      "requiresLecture": false
    },
    {
      "code": "COMMANDER_SONY",
      "label": "ワイヤレスコマンダー（SONY専用）",
      "stock": 1,
      "unitPriceJpy": 300,
      "unitLabel": "",
      "requiresLecture": false
    },
    {
      "code": "STAND_260",
      "label": "ライトスタンド（260cm）",
      "stock": 3,
      "unitPriceJpy": 200,
      "unitLabel": "本",
      "requiresLecture": false
    },
    {
      "code": "BOWENS_BRACKET",
      "label": "ボーエンズマウントブラケット",
      "stock": 1,
      "unitPriceJpy": 200,
      "unitLabel": "",
      "requiresLecture": false
    },
    {
      "code": "SOFTBOX_STRIP_60X90",
      "label": "ストリップソフトボックス（60×90cm）",
      "stock": 1,
      "unitPriceJpy": 300,
      "unitLabel": "",
      "requiresLecture": false
    },
    {
      "code": "SOFTBOX_STRIP_30X120",
      "label": "ストリップソフトボックス（30×120cm）",
      "stock": 1,
      "unitPriceJpy": 300,
      "unitLabel": "",
      "requiresLecture": false
    },
    {
      "code": "SOFTBOX_60",
      "label": "ソフトボックス（60cm）",
      "stock": 1,
      "unitPriceJpy": 300,
      "unitLabel": "",
      "requiresLecture": false
    },
    {
      "code": "COLOR_FILTER_SET",
      "label": "カラーフィルター（8色セット）",
      "stock": 1,
      "unitPriceJpy": 200,
      "unitLabel": "",
      "requiresLecture": false
    }
  ],
  "freeSelf": [
    {
      "code": "BACKGROUND_STAND",
      "label": "背景スタンド",
      "stock": 1,
      "selectable": true
    },
    {
      "code": "BACKDROP_CLOTH_WHITE",
      "label": "背景布 白（幅180cm×長さ250cm）",
      "stock": 1,
      "selectable": false,
      "viaTheme": "WHITE_BACKDROP"
    },
    {
      "code": "BACKDROP_CLOTH_BLACK",
      "label": "背景布 黒（幅180cm×長さ250cm）",
      "stock": 1,
      "selectable": false,
      "viaTheme": "BLACK_BACKDROP"
    }
  ]
};
