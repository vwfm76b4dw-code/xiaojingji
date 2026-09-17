/**
 * 主题分类表 —— 供问词页的"同类词"检索（相似度算法做不到这件事）。
 *
 * 本文件由 tools/build-topics.js 自动生成，请勿手改。
 * 来源：词卡的已有标签（归并别名）+ 中文释义关键词匹配。
 * 生成时间：2026-09-17
 *
 * 学生问「课本里学校用品有哪些词」时，答案只能来自这张表：
 * geography 与 biology 在字母层面毫无关系，靠相似度永远找不到彼此。
 */
module.exports = {
  "人物": {
    "words": [
      "culture",
      "hero",
      "peaceful",
      "support"
    ],
    "alias": []
  },
  "健康": {
    "words": [
      "dead",
      "emergency",
      "medical"
    ],
    "alias": []
  },
  "动物": {
    "words": [
      "bamboo",
      "beaver",
      "die out",
      "dodo",
      "dolphin"
    ],
    "alias": []
  },
  "地理": {
    "words": [
      "climate",
      "island",
      "ocean",
      "rainforest"
    ],
    "alias": [
      "地理学"
    ]
  },
  "天气": {
    "words": [
      "forest",
      "rainforest",
      "storm",
      "view",
      "wind"
    ],
    "alias": [
      "气候"
    ]
  },
  "学习用品": {
    "words": [
      "eraser",
      "notebook",
      "textbook"
    ],
    "alias": [
      "文具",
      "学校用品",
      "学习用具",
      "学习物品"
    ]
  },
  "学校场所": {
    "words": [
      "absent",
      "dining hall",
      "lab",
      "project",
      "teaching building"
    ],
    "alias": [
      "校园场所",
      "学校地方"
    ]
  },
  "学科": {
    "words": [
      "as happy as a clam",
      "biology",
      "biscuit",
      "chemistry",
      "club",
      "geography",
      "history",
      "oxygen",
      "physics",
      "problem",
      "product",
      "solve",
      "together"
    ],
    "alias": [
      "科目",
      "课程"
    ]
  },
  "情绪感受": {
    "words": [
      "amazing",
      "as happy as a clam",
      "boring",
      "care",
      "fantastic",
      "full",
      "joy",
      "lonely",
      "nervous",
      "regret",
      "surprise",
      "yourself"
    ],
    "alias": [
      "心情",
      "情绪",
      "感受"
    ]
  },
  "文化": {
    "words": [
      "museum",
      "paper-cutting",
      "teahouse"
    ],
    "alias": []
  },
  "方位": {
    "words": [
      "arrive",
      "get lost",
      "within"
    ],
    "alias": []
  },
  "日常活动": {
    "words": [
      "absent",
      "dining hall"
    ],
    "alias": [
      "日常生活",
      "每天做的事"
    ]
  },
  "时间": {
    "words": [
      "midnight",
      "quarter",
      "soon",
      "weekend",
      "within"
    ],
    "alias": [
      "时刻",
      "日期"
    ]
  },
  "植物": {
    "words": [
      "corn silk",
      "cotton",
      "leaf",
      "root",
      "seed",
      "stem",
      "sunflower"
    ],
    "alias": []
  },
  "环境": {
    "words": [
      "plastic",
      "pollution",
      "waste"
    ],
    "alias": []
  },
  "自然": {
    "words": [
      "forest",
      "natural",
      "nature",
      "shine",
      "wild"
    ],
    "alias": [
      "大自然"
    ]
  },
  "节日": {
    "words": [
      "Christmas",
      "celebrate"
    ],
    "alias": []
  },
  "衣物": {
    "words": [
      "hat",
      "jacket"
    ],
    "alias": []
  },
  "身体": {
    "words": [
      "breathe",
      "heart",
      "nod",
      "shape",
      "thirsty"
    ],
    "alias": []
  },
  "运动健康": {
    "words": [
      "activity",
      "hat",
      "hold",
      "physics",
      "pool",
      "race（n.）",
      "race（v.）",
      "skate",
      "speed",
      "volleyball"
    ],
    "alias": [
      "体育",
      "锻炼",
      "健身"
    ]
  },
  "通讯科技": {
    "words": [
      "emergency",
      "information technology",
      "social media"
    ],
    "alias": [
      "科技",
      "通讯",
      "电子设备"
    ]
  },
  "音乐": {
    "words": [
      "band",
      "guitar"
    ],
    "alias": []
  },
  "饮食": {
    "words": [
      "coffee",
      "dining hall",
      "dish",
      "dumpling",
      "feed",
      "meal",
      "mix",
      "pain",
      "pork",
      "sugar",
      "treat"
    ],
    "alias": [
      "吃的",
      "食物",
      "饮食"
    ]
  }
};
